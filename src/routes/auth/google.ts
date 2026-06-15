// Spec 007 §7 — Google OIDC + token rotation / logout route handlers.
//
// Mounted by `googleAuthPlugin` from src/lib/auth-google/index.ts. JSON
// Schema bodies drive Fastify's built-in validation; spec 005's errorHandler
// converts failures to VALIDATION_FAILED RFC 7807.

import { Type } from '@sinclair/typebox'
import type { FastifyInstance } from 'fastify'

import {
  ErrorCode,
  UnauthorizedError,
} from '../../lib/errors/index.js'
import {
  loadAccountRole,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  createRefreshStore,
  type TokenSecrets,
  type TokenBundle,
} from '../../lib/auth/index.js'
import {
  extractBearer,
  isExpiryError,
  requireAccessAccountId,
} from '../../lib/auth/bearer.js'
import type { GoogleAuthService } from '../../lib/auth-google/service.js'
import { registerWithV1Alias } from '../../lib/http/index.js'
import type { LimitWindow } from '../../lib/rate-limit/index.js'

const REFRESH_IP: LimitWindow = { limit: 30, windowMs: 60 * 1000 }
const EXCHANGE_IP: LimitWindow = { limit: 30, windowMs: 60 * 1000 }
const AUTHORIZE_INIT_IP: LimitWindow = { limit: 30, windowMs: 60 * 1000 }

interface AuthorizeInitBody {
  returnTo?: string
}

interface ExchangeBody {
  sid: string
  code: string
  state: string
}

interface LogoutBody {
  refreshToken?: string
}

export interface RegisterGoogleAuthRoutesDeps {
  service: GoogleAuthService
  tokenSecrets: TokenSecrets
}

export async function registerGoogleAuthRoutes(
  app: FastifyInstance,
  deps: RegisterGoogleAuthRoutesDeps,
): Promise<void> {
  const { service, tokenSecrets } = deps
  const refreshStore = createRefreshStore(app.redis)

  // ── POST /auth/google/authorize-init (spec §7.1) ────────────────────────
  registerWithV1Alias<{ Body: AuthorizeInitBody; Querystring: { intent?: 'login' | 'link' } }>(app, {
    method: 'POST',
    url: '/auth/google/authorize-init',
    schema: {
      querystring: Type.Object({
        intent: Type.Optional(
          Type.Union([Type.Literal('login'), Type.Literal('link')], { default: 'login' }),
        ),
      }),
      body: Type.Object({
        returnTo: Type.Optional(Type.String({ maxLength: 2048 })),
      }),
    },
    config: { rateLimit: { perIp: AUTHORIZE_INIT_IP } },
    handler: async (req, reply) => {
      const intent = req.query.intent ?? 'login'
      if (intent === 'link') {
        const accountId = await requireAccessAccountId(req, tokenSecrets)
        const out = await service.authorizeInit({ intent, accountId })
        req.log.info(
          { event: 'auth_authorize_init', intent, accountId, sid: out.sid },
          'authorize-init',
        )
        return reply.ok(out)
      }
      const out = await service.authorizeInit({
        intent,
        ...(req.body.returnTo !== undefined ? { returnTo: req.body.returnTo } : {}),
      })
      req.log.info(
        { event: 'auth_authorize_init', intent, sid: out.sid },
        'authorize-init',
      )
      return reply.ok(out)
    },
  })

  // ── POST /auth/google/exchange (spec §7.2) ──────────────────────────────
  registerWithV1Alias<{ Body: ExchangeBody }>(app, {
    method: 'POST',
    url: '/auth/google/exchange',
    schema: {
      body: Type.Object({
        sid: Type.String({ minLength: 8, maxLength: 64 }),
        code: Type.String({ minLength: 1, maxLength: 4096 }),
        state: Type.String({ minLength: 8, maxLength: 256 }),
      }),
    },
    config: { rateLimit: { perIp: EXCHANGE_IP } },
    handler: async (req, reply) => {
      // For intent=link, an access token must accompany the call. We accept
      // its presence as a HINT and pass the accountId to the service; the
      // service still asserts session.intent and accountId match.
      let callerAccountId: string | undefined
      const authHeader = req.headers.authorization
      if (typeof authHeader === 'string' && /^bearer /i.test(authHeader)) {
        callerAccountId = await requireAccessAccountId(req, tokenSecrets)
      }
      const result = await service.exchange({
        sid: req.body.sid,
        code: req.body.code,
        state: req.body.state,
        ...(callerAccountId !== undefined ? { callerAccountId } : {}),
      })
      if (result.intent === 'login') {
        req.log.info(
          { event: 'auth_exchange_success', audit: true, intent: 'login' },
          'google exchange success',
        )
        return reply.ok({
          ...result.bundle,
          ...(result.returnTo !== undefined ? { returnTo: result.returnTo } : {}),
        })
      }
      req.log.info(
        {
          event: 'auth_account_linked',
          audit: true,
          accountId: callerAccountId,
        },
        'google credential linked',
      )
      return reply.noContent()
    },
  })

  // ── POST /auth/refresh (spec §7.3) ──────────────────────────────────────
  registerWithV1Alias(app, {
    method: 'POST',
    url: '/auth/refresh',
    config: { rateLimit: { perIp: REFRESH_IP } },
    handler: async (req, reply) => {
      const refreshJwt = extractBearer(req)
      let claims
      try {
        claims = await verifyRefreshToken(refreshJwt, tokenSecrets)
      } catch (err) {
        // Spec §12 — distinguish "expired" from "unauthorized" when fast-jwt
        // signals expiry.
        const code = isExpiryError(err)
          ? ErrorCode.AUTH_TOKEN_EXPIRED
          : ErrorCode.UNAUTHORIZED
        throw new UnauthorizedError({
          code,
          message: code === ErrorCode.AUTH_TOKEN_EXPIRED ? 'Token expired' : 'Unauthorized',
          cause: err,
        })
      }

      const outcome = await refreshStore.consume(claims.jti, refreshJwt)
      if (outcome.result === 'not-found') {
        throw new UnauthorizedError({
          code: ErrorCode.AUTH_REFRESH_REVOKED,
          message: 'Refresh token revoked',
        })
      }
      if (outcome.result === 'replay') {
        // Spec §11.4 / §13.6 — revoke all the user's refresh tokens.
        await refreshStore.revokeAll(outcome.accountId)
        req.log.warn(
          { event: 'auth_refresh_replay', accountId: outcome.accountId, audit: true },
          'refresh token replay detected',
        )
        throw new UnauthorizedError({
          code: ErrorCode.AUTH_REFRESH_REPLAY,
          message: 'Refresh token reuse detected; please sign in again',
        })
      }
      // Spec 007 §10.9 v0.4 — reject disabled accounts on refresh. We don't
      // sweep their refresh tokens at archive/delete time, so the per-request
      // check is the catch-net. Also revoke all their existing refresh
      // tokens so subsequent attempts fail loud rather than the same path.
      const account = await app.prisma.account.findUnique({
        where: { id: outcome.accountId },
        select: { archivedAt: true, deletedAt: true },
      })
      if (!account || account.archivedAt !== null || account.deletedAt !== null) {
        await refreshStore.revokeAll(outcome.accountId)
        throw new UnauthorizedError({
          code: ErrorCode.AUTH_ACCOUNT_DISABLED,
          message: 'Account is disabled',
        })
      }

      // Spec §5.1 — mint a fresh bundle.
      const bundle = await issueBundle(outcome.accountId)
      req.log.info(
        { event: 'auth_refresh_success', accountId: outcome.accountId },
        'refresh rotation success',
      )
      return reply.ok(bundle)
    },
  })

  // ── POST /auth/logout (spec §7.4) ───────────────────────────────────────
  registerWithV1Alias<{ Body: LogoutBody }>(app, {
    method: 'POST',
    url: '/auth/logout',
    schema: {
      body: Type.Optional(
        Type.Object({
          refreshToken: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        }),
      ),
    },
    handler: async (req, reply) => {
      const accountId = await requireAccessAccountId(req, tokenSecrets)
      const body = (req.body ?? {}) as LogoutBody
      if (typeof body.refreshToken === 'string' && body.refreshToken.length > 0) {
        try {
          const claims = await verifyRefreshToken(body.refreshToken, tokenSecrets)
          if (claims.sub === accountId) {
            await refreshStore.revokeOne(claims.jti)
          }
        } catch {
          // Spec §12 — opaque on invalid refresh during logout. Still 204.
        }
      }
      req.log.info({ event: 'auth_logout', accountId, audit: true }, 'auth logout')
      return reply.noContent()
    },
  })

  // ── POST /auth/logout-all (spec §7.5) ───────────────────────────────────
  registerWithV1Alias(app, {
    method: 'POST',
    url: '/auth/logout-all',
    handler: async (req, reply) => {
      const accountId = await requireAccessAccountId(req, tokenSecrets)
      await refreshStore.revokeAll(accountId)
      req.log.info(
        { event: 'auth_logout_all', accountId, audit: true },
        'auth logout-all',
      )
      return reply.noContent()
    },
  })

  async function issueBundle(accountId: string): Promise<TokenBundle> {
    // Spec 020 v0.2 §2.3 — fresh role read on refresh path too.
    const role = await loadAccountRole(app.prisma, accountId)
    const [access, refresh] = await Promise.all([
      signAccessToken(accountId, tokenSecrets, role),
      signRefreshToken(accountId, tokenSecrets),
    ])
    await refreshStore.store({
      accountId,
      tokenId: refresh.tokenId,
      token: refresh.token,
      refreshTtlSec: tokenSecrets.refreshTtlSec,
    })
    return {
      accessToken: access.token,
      accessExpiresIn: access.expiresIn,
      refreshToken: refresh.token,
      refreshExpiresIn: refresh.expiresIn,
      tokenType: 'Bearer',
    }
  }
}

// `extractBearer`, `requireAccessAccountId`, `isExpiryError` lifted to
// `src/lib/auth/bearer.ts` so /auth/me/* can reuse the same verify path.
