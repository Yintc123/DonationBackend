// Spec 007 §4 / §10 — Google OAuth / OIDC orchestrator.
//
// Composes the pure helpers (state store, ID token verifier, account
// resolver) into a transactional service consumed by route handlers.

import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import type { Redis } from 'ioredis'

import {
  ConflictError,
  ErrorCode,
  GatewayTimeoutError,
  UnauthorizedError,
} from '../errors/index.js'
import {
  createRefreshStore,
  signAccessToken,
  signRefreshToken,
  type TokenSecrets,
  type TokenBundle,
} from '../auth/index.js'

import {
  resolveGoogleLink,
  resolveGoogleLogin,
  type GoogleLinkLookups,
  type GoogleLookups,
} from './account-resolver.js'
import { createOidcDiscovery, type OidcDiscovery } from './discovery.js'
import {
  ExchangeFailedError,
  UpstreamFailureError,
  exchangeCodeForIdToken,
} from './exchange.js'
import {
  IdTokenError,
  verifyGoogleIdToken,
  type VerifiedGoogleIdToken,
} from './id-token.js'
import {
  computeCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
  timingSafeEqualStr,
} from './pkce.js'
import {
  createOAuthSessionStore,
  type OAuthSessionStore,
  type OAuthIntent,
} from './state.js'

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

export interface GoogleAuthDeps {
  prisma: PrismaClient
  redis: Redis
  tokenSecrets: TokenSecrets
  googleClientId: string
  googleClientSecret: string
  googleRedirectUri: string
  oidcDiscoveryUrl: string
  /** Test seam: override the upstream HTTP client. */
  fetchImpl?: typeof fetch
  /** Test seam: override the URL Google's `/token` lives at. Falls back to
   *  the OIDC discovery document at runtime. */
  tokenEndpointOverride?: string
}

export interface AuthorizeInitInput {
  intent: OAuthIntent
  returnTo?: string
  /** Set when intent='link' — the authenticated account that initiated linking. */
  accountId?: string
}

export interface AuthorizeInitOutput {
  sid: string
  authUrl: string
}

export interface ExchangeInput {
  sid: string
  code: string
  state: string
  /** Required when intent='link' — the JWT.sub of the caller; spec §10.6. */
  callerAccountId?: string
}

export type ExchangeOutput =
  | { intent: 'login'; bundle: TokenBundle; returnTo?: string }
  | { intent: 'link' }

export interface GoogleAuthService {
  authorizeInit(input: AuthorizeInitInput): Promise<AuthorizeInitOutput>
  exchange(input: ExchangeInput): Promise<ExchangeOutput>
}

export function createGoogleAuthService(deps: GoogleAuthDeps): GoogleAuthService {
  const sessionStore: OAuthSessionStore = createOAuthSessionStore(deps.redis)
  const refreshStore = createRefreshStore(deps.redis)
  const discovery: OidcDiscovery = createOidcDiscovery({
    discoveryUrl: deps.oidcDiscoveryUrl,
    fetchImpl: deps.fetchImpl,
  })

  const lookups: GoogleLookups = {
    findAccountByGoogleSub: async (sub) => {
      const cred = await deps.prisma.googleCredential.findUnique({
        where: { externalId: sub },
      })
      return cred ? { id: cred.accountId } : null
    },
    findAccountByEmail: async (email) => {
      const account = await deps.prisma.account.findUnique({ where: { email } })
      return account ? { id: account.id } : null
    },
  }
  const linkLookups: GoogleLinkLookups = {
    findAccountByGoogleSub: lookups.findAccountByGoogleSub,
    accountHasGoogleCredential: async (accountId) => {
      const cred = await deps.prisma.googleCredential.findUnique({ where: { accountId } })
      return cred !== null
    },
  }

  async function issueBundle(accountId: string): Promise<TokenBundle> {
    const [access, refresh] = await Promise.all([
      signAccessToken(accountId, deps.tokenSecrets),
      signRefreshToken(accountId, deps.tokenSecrets),
    ])
    await refreshStore.store({
      accountId,
      tokenId: refresh.tokenId,
      token: refresh.token,
      refreshTtlSec: deps.tokenSecrets.refreshTtlSec,
    })
    return {
      accessToken: access.token,
      accessExpiresIn: access.expiresIn,
      refreshToken: refresh.token,
      refreshExpiresIn: refresh.expiresIn,
      tokenType: 'Bearer',
    }
  }

  async function verifyIdTokenWithRetry(
    idToken: string,
    nonce: string,
  ): Promise<VerifiedGoogleIdToken> {
    let jwks = await discovery.getJwks()
    try {
      return await verifyGoogleIdToken(idToken, {
        audience: deps.googleClientId,
        nonce,
        jwks,
      })
    } catch (firstErr) {
      // Spec §8.2 — on kid miss force refresh once then retry.
      if (!(firstErr instanceof IdTokenError) || !/kid/i.test(firstErr.message)) {
        throw firstErr
      }
      jwks = await discovery.refresh()
      return verifyGoogleIdToken(idToken, {
        audience: deps.googleClientId,
        nonce,
        jwks,
      })
    }
  }

  return {
    async authorizeInit(input) {
      const sid = randomUUID()
      const state = generateState()
      const nonce = generateNonce()
      const codeVerifier = generateCodeVerifier()
      const challenge = computeCodeChallenge(codeVerifier)

      await sessionStore.put(sid, {
        state,
        nonce,
        codeVerifier,
        intent: input.intent,
        ...(input.returnTo !== undefined ? { returnTo: input.returnTo } : {}),
        ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      })

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: deps.googleClientId,
        redirect_uri: deps.googleRedirectUri,
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
        access_type: 'online',
      })
      const authUrl = `${GOOGLE_AUTHORIZATION_ENDPOINT}?${params.toString()}`
      return { sid, authUrl }
    },

    async exchange(input) {
      // Spec §4.2 Step 4(1) — read & delete the OAuth session.
      const session = await sessionStore.consumeAndDelete(input.sid)
      if (!session) {
        throw new UnauthorizedError({
          code: ErrorCode.AUTH_OAUTH_SESSION_INVALID,
          message: 'OAuth session expired or invalid',
        })
      }

      // Spec §4.2 Step 4(2) — timing-safe state compare.
      if (!timingSafeEqualStr(session.state, input.state)) {
        throw new UnauthorizedError({
          code: ErrorCode.AUTH_STATE_MISMATCH,
          message: 'Invalid state parameter',
        })
      }

      // Spec §10.6 — link intent requires the caller's JWT.sub to match the
      // accountId we stamped on the session at authorize-init time.
      if (session.intent === 'link') {
        if (!input.callerAccountId || input.callerAccountId !== session.accountId) {
          throw new UnauthorizedError({
            code: ErrorCode.AUTH_LINK_SESSION_MISMATCH,
            message: 'Link session mismatch',
          })
        }
      }

      // Spec §4.2 Step 4(4) — exchange code for tokens.
      let exchangeResult
      try {
        exchangeResult = await exchangeCodeForIdToken({
          tokenUrl: deps.tokenEndpointOverride ?? GOOGLE_TOKEN_ENDPOINT,
          code: input.code,
          codeVerifier: session.codeVerifier,
          clientId: deps.googleClientId,
          clientSecret: deps.googleClientSecret,
          redirectUri: deps.googleRedirectUri,
          fetchImpl: deps.fetchImpl,
        })
      } catch (err) {
        if (err instanceof ExchangeFailedError) {
          throw new UnauthorizedError({
            code: ErrorCode.AUTH_OAUTH_EXCHANGE_FAILED,
            message: 'OAuth exchange failed',
            cause: err,
          })
        }
        if (err instanceof UpstreamFailureError) {
          throw new GatewayTimeoutError({
            code: ErrorCode.UPSTREAM_FAILURE,
            message: 'Identity provider unavailable',
            cause: err,
          })
        }
        throw err
      }

      // Spec §4.2 Step 4(6) — verify the ID Token.
      let identity: VerifiedGoogleIdToken
      try {
        identity = await verifyIdTokenWithRetry(exchangeResult.idToken, session.nonce)
      } catch (err) {
        if (err instanceof IdTokenError && /email_verified/i.test(err.message)) {
          throw new UnauthorizedError({
            code: ErrorCode.AUTH_EMAIL_UNVERIFIED,
            message: 'Email is not verified',
            cause: err,
          })
        }
        throw new UnauthorizedError({
          code: ErrorCode.AUTH_ID_TOKEN_INVALID,
          message: 'Identity token invalid',
          cause: err,
        })
      }

      if (session.intent === 'login') {
        const resolution = await resolveGoogleLogin(
          { sub: identity.sub, email: identity.email },
          lookups,
        )
        if (resolution.action === 'collision') {
          throw new ConflictError({
            code: ErrorCode.AUTH_EMAIL_OWNED_BY_OTHER_ACCOUNT,
            message:
              'Email belongs to another account. Sign in with that account first, then link Google in settings.',
          })
        }
        let accountId: string
        if (resolution.action === 'login') {
          accountId = resolution.accountId
        } else {
          // Spec §10.4 — Account + GoogleCredential in one transaction.
          const created = await deps.prisma.account.create({
            data: {
              email: resolution.email,
              googleCredential: {
                create: {
                  externalId: resolution.sub,
                  email: resolution.email,
                },
              },
            },
          })
          accountId = created.id
        }
        const bundle = await issueBundle(accountId)
        return {
          intent: 'login',
          bundle,
          ...(session.returnTo !== undefined ? { returnTo: session.returnTo } : {}),
        }
      }

      // Link intent — must have an authenticated callerAccountId.
      const accountId = input.callerAccountId as string
      const link = await resolveGoogleLink(
        accountId,
        { sub: identity.sub, email: identity.email },
        linkLookups,
      )
      if (link.action === 'already-linked-elsewhere') {
        throw new ConflictError({
          code: ErrorCode.AUTH_GOOGLE_ALREADY_LINKED,
          message: 'This Google account is already linked elsewhere',
        })
      }
      if (link.action === 'credential-exists') {
        throw new ConflictError({
          code: ErrorCode.AUTH_CREDENTIAL_EXISTS,
          message: 'Google is already linked to this account',
        })
      }
      await deps.prisma.googleCredential.create({
        data: {
          accountId,
          externalId: identity.sub,
          email: identity.email.toLowerCase(),
        },
      })
      return { intent: 'link' }
    },
  }
}
