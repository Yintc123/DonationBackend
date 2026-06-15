// Spec 007 §16.2 — integration coverage of the Google OIDC + refresh +
// logout flow.
//
// buildApp() registers googleAuthPlugin globally via src/app.ts so this
// test does not require modifying src/app.ts (the caller will wire it
// alongside authPlugin in a follow-up).
//
// MSW intercepts every outbound HTTPS call to Google's discovery / JWKS /
// token endpoints; tests sign their own ID tokens with the same key fixture
// the JWKS handler advertises so verification passes end-to-end.

import type { FastifyInstance } from 'fastify'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { decodeJwtUnsafe } from '../../src/lib/auth/index.js'
import { buildApp } from '../helpers/app.js'
import {
  GOOGLE_TOKEN_URL,
  createGoogleMsw,
  type GoogleMswSetup,
} from '../helpers/msw.js'

const AUTH_TEST_ENV: Record<string, string> = {
  // Match what auth-password integration uses so we don't trip rate limits.
  PASSWORD_HASH_MEMORY_COST: '8192',
  PASSWORD_HASH_TIME_COST: '2',
  PASSWORD_HASH_PARALLELISM: '1',
  PASSWORD_MIN_LENGTH: '8',
  RATE_LIMIT_GLOBAL_PER_IP_LIMIT: '10000',
  RATE_LIMIT_GLOBAL_PER_IP_WINDOW_SEC: '60',
  RATE_LIMIT_DEFAULT_LIMIT: '10000',
  RATE_LIMIT_DEFAULT_WINDOW_SEC: '60',
}

interface TokenBundleResponse {
  accessToken: string
  accessExpiresIn: number
  refreshToken: string
  refreshExpiresIn: number
  tokenType: 'Bearer'
  returnTo?: string
}

interface ProblemResponse {
  code: string
  status: number
  title: string
}

const CLIENT_ID = 'test-google-client-id'
const REDIRECT_URI = 'http://localhost:3000/api/auth/google/callback'

let google: GoogleMswSetup
const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
beforeEach(() => {
  google = createGoogleMsw()
  server.use(...google.handlers)
})
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

async function buildGoogleApp(
  envOverrides: Record<string, string> = {},
): Promise<FastifyInstance> {
  // buildApp() registers googleAuthPlugin globally via src/app.ts.
  const app = await buildApp({ ...AUTH_TEST_ENV, ...envOverrides })
  await app.ready()
  return app
}

interface AuthorizeInitResponse {
  sid: string
  authUrl: string
}

async function authorizeInit(
  app: FastifyInstance,
  opts: { intent?: 'login' | 'link'; accessToken?: string; returnTo?: string } = {},
): Promise<AuthorizeInitResponse> {
  const intent = opts.intent ?? 'login'
  const headers: Record<string, string> = {}
  if (opts.accessToken) headers.authorization = `Bearer ${opts.accessToken}`
  const res = await app.inject({
    method: 'POST',
    url: `/auth/google/authorize-init?intent=${intent}`,
    headers,
    payload: opts.returnTo ? { returnTo: opts.returnTo } : {},
  })
  if (res.statusCode !== 200) {
    throw new Error(`authorize-init failed: ${res.statusCode} ${res.body}`)
  }
  return res.json() as AuthorizeInitResponse
}

function extractAuthParam(authUrl: string, name: string): string {
  const params = new URLSearchParams(authUrl.split('?')[1] ?? '')
  return params.get(name) ?? ''
}

const ONE_HOUR = 60 * 60
function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function defaultIdTokenPayload(args: {
  nonce: string
  sub?: string
  email?: string
  emailVerified?: boolean
}): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: args.sub ?? 'google-sub-123',
    email: args.email ?? 'user@example.com',
    email_verified: args.emailVerified ?? true,
    nonce: args.nonce,
    iat: nowSec() - 5,
    exp: nowSec() + ONE_HOUR,
  }
}

describe('auth-google integration (spec 007)', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // ── /authorize-init (spec §7.1) ─────────────────────────────────────────
  describe('POST /auth/google/authorize-init', () => {
    it('returns { sid, authUrl } with required Google OAuth params for intent=login', async () => {
      app = await buildGoogleApp()
      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/authorize-init',
        payload: {},
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as AuthorizeInitResponse
      expect(body.sid).toMatch(/^[0-9a-f-]{36}$/i)
      expect(body.authUrl).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/)
      expect(extractAuthParam(body.authUrl, 'response_type')).toBe('code')
      expect(extractAuthParam(body.authUrl, 'client_id')).toBe(CLIENT_ID)
      expect(extractAuthParam(body.authUrl, 'redirect_uri')).toBe(REDIRECT_URI)
      expect(extractAuthParam(body.authUrl, 'code_challenge_method')).toBe('S256')
      expect(extractAuthParam(body.authUrl, 'state').length).toBeGreaterThanOrEqual(43)
      expect(extractAuthParam(body.authUrl, 'nonce').length).toBeGreaterThanOrEqual(43)
      expect(extractAuthParam(body.authUrl, 'code_challenge').length).toBeGreaterThan(0)
    })

    it('persists state / nonce / codeVerifier in Redis under jkod:auth:oauth:{sid}', async () => {
      app = await buildGoogleApp()
      const { sid } = await authorizeInit(app)
      // Read via the same prefixed `app.redis` client the store uses —
      // ioredis transparently prepends `jkod:`, so the lookup string here
      // is the un-prefixed form `auth:oauth:{sid}` and the actual stored
      // key in Redis is `jkod:auth:oauth:{sid}` (spec 006 §3).
      const stored = await app.redis.hgetall(`auth:oauth:${sid}`)
      expect(stored.state?.length ?? 0).toBeGreaterThan(0)
      expect(stored.nonce?.length ?? 0).toBeGreaterThan(0)
      expect(stored.codeVerifier?.length ?? 0).toBeGreaterThan(0)
      expect(stored.intent).toBe('login')
    })

    it('drops an off-domain returnTo at the trust boundary (spec §13.8)', async () => {
      app = await buildGoogleApp()
      const { sid } = await authorizeInit(app, { returnTo: 'https://evil.com/steal' })
      const stored = await app.redis.hgetall(`auth:oauth:${sid}`)
      expect(stored.returnTo).toBeUndefined()
    })

    it('keeps a relative-path returnTo (spec §13.8)', async () => {
      app = await buildGoogleApp()
      const { sid } = await authorizeInit(app, { returnTo: '/dashboard' })
      const stored = await app.redis.hgetall(`auth:oauth:${sid}`)
      expect(stored.returnTo).toBe('/dashboard')
    })

    it('rejects intent=link without an authenticated bearer token (spec §10.6)', async () => {
      app = await buildGoogleApp()
      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/authorize-init?intent=link',
        payload: {},
      })
      expect(res.statusCode).toBe(401)
      const body = res.json() as ProblemResponse
      expect(body.code).toBe('UNAUTHORIZED')
    })
  })

  // ── /exchange happy paths (spec §4.2 / §10.3) ───────────────────────────
  describe('POST /auth/google/exchange (login intent)', () => {
    it('creates a new Account + GoogleCredential and returns tokens on first sign-in', async () => {
      app = await buildGoogleApp()
      const { sid, authUrl } = await authorizeInit(app)
      const nonce = extractAuthParam(authUrl, 'nonce')
      const state = extractAuthParam(authUrl, 'state')
      const idToken = google.signIdToken(
        defaultIdTokenPayload({ nonce, sub: 'sub-first-login', email: 'first@example.com' }),
      )
      google.enqueueTokenResponse(idToken)

      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/exchange',
        payload: { sid, code: 'authz-code', state },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as TokenBundleResponse
      expect(body.tokenType).toBe('Bearer')
      expect(typeof body.accessToken).toBe('string')

      const account = await app.prisma.account.findUnique({
        where: { email: 'first@example.com' },
        include: { googleCredential: true },
      })
      expect(account).not.toBeNull()
      expect(account?.googleCredential?.externalId).toBe('sub-first-login')

      // Verify Google's /token call carried the form params per spec §4.3.
      const upstreamForm = google.lastTokenRequest()
      expect(upstreamForm?.get('grant_type')).toBe('authorization_code')
      expect(upstreamForm?.get('code')).toBe('authz-code')
      expect(upstreamForm?.get('client_id')).toBe(CLIENT_ID)
      expect(upstreamForm?.get('redirect_uri')).toBe(REDIRECT_URI)
    })

    it('logs in an existing user when the Google sub is already linked', async () => {
      app = await buildGoogleApp()
      // Seed: account + google credential.
      const seeded = await app.prisma.account.create({
        data: {
          email: 'existing@example.com',
          googleCredential: {
            create: { externalId: 'sub-existing', email: 'existing@example.com' },
          },
        },
      })

      const { sid, authUrl } = await authorizeInit(app)
      const nonce = extractAuthParam(authUrl, 'nonce')
      const state = extractAuthParam(authUrl, 'state')
      const idToken = google.signIdToken(
        defaultIdTokenPayload({ nonce, sub: 'sub-existing', email: 'existing@example.com' }),
      )
      google.enqueueTokenResponse(idToken)

      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/exchange',
        payload: { sid, code: 'authz-code', state },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as TokenBundleResponse
      const accessClaims = decodeJwtUnsafe(body.accessToken)
      expect(accessClaims.sub).toBe(seeded.id)
    })

    it('deletes the OAuth session from Redis after a successful exchange (one-shot, §9.1)', async () => {
      app = await buildGoogleApp()
      const { sid, authUrl } = await authorizeInit(app)
      const nonce = extractAuthParam(authUrl, 'nonce')
      const state = extractAuthParam(authUrl, 'state')
      const idToken = google.signIdToken(
        defaultIdTokenPayload({ nonce, sub: 'sub-once', email: 'once@example.com' }),
      )
      google.enqueueTokenResponse(idToken)
      await app.inject({
        method: 'POST',
        url: '/auth/google/exchange',
        payload: { sid, code: 'authz-code', state },
      })
      const remaining = await app.redis.hgetall(`auth:oauth:${sid}`)
      expect(remaining).toEqual({})
    })

    // ── spec 007 §10.2 / spec 008 §5.4 — lastLogin audit ──
    it('new-account branch sets lastLoginAt + lastLoginType=GOOGLE', async () => {
      app = await buildGoogleApp()
      const { sid, authUrl } = await authorizeInit(app)
      const nonce = extractAuthParam(authUrl, 'nonce')
      const state = extractAuthParam(authUrl, 'state')
      const idToken = google.signIdToken(
        defaultIdTokenPayload({ nonce, sub: 'sub-audit-new', email: 'new-audit@example.com' }),
      )
      google.enqueueTokenResponse(idToken)
      const before = Date.now()

      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/exchange',
        payload: { sid, code: 'authz-code', state },
      })
      expect(res.statusCode).toBe(200)

      const account = await app.prisma.account.findUnique({
        where: { email: 'new-audit@example.com' },
      })
      expect(account?.lastLoginType).toBe('GOOGLE')
      const ts = account?.lastLoginAt?.getTime() ?? 0
      expect(ts).toBeGreaterThanOrEqual(before)
      expect(ts).toBeLessThanOrEqual(Date.now() + 1000)
    })

    it('existing-account login updates lastLoginAt to a newer timestamp (GOOGLE)', async () => {
      app = await buildGoogleApp()
      const ancientTs = new Date('2026-01-01T00:00:00.000Z')
      const seeded = await app.prisma.account.create({
        data: {
          email: 'returning-audit@example.com',
          lastLoginAt: ancientTs,
          lastLoginType: 'GOOGLE',
          googleCredential: {
            create: {
              externalId: 'sub-audit-returning',
              email: 'returning-audit@example.com',
            },
          },
        },
      })

      const { sid, authUrl } = await authorizeInit(app)
      const nonce = extractAuthParam(authUrl, 'nonce')
      const state = extractAuthParam(authUrl, 'state')
      const idToken = google.signIdToken(
        defaultIdTokenPayload({
          nonce,
          sub: 'sub-audit-returning',
          email: 'returning-audit@example.com',
        }),
      )
      google.enqueueTokenResponse(idToken)

      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/exchange',
        payload: { sid, code: 'authz-code', state },
      })
      expect(res.statusCode).toBe(200)

      const account = await app.prisma.account.findUnique({
        where: { id: seeded.id },
      })
      expect(account?.lastLoginType).toBe('GOOGLE')
      expect(account?.lastLoginAt?.getTime() ?? 0).toBeGreaterThan(ancientTs.getTime())
    })
  })

  // ── /exchange error paths (spec §12) ────────────────────────────────────
  describe('POST /auth/google/exchange — error cases', () => {
    it('returns 401 AUTH_OAUTH_SESSION_INVALID when sid is unknown', async () => {
      app = await buildGoogleApp()
      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/exchange',
        payload: {
          sid: '00000000-0000-0000-0000-000000000000',
          code: 'c',
          state: 'state-zzzzzzzzzzzzz',
        },
      })
      expect(res.statusCode).toBe(401)
      expect((res.json() as ProblemResponse).code).toBe('AUTH_OAUTH_SESSION_INVALID')
    })

    it('returns 401 AUTH_STATE_MISMATCH when state does not match Redis', async () => {
      app = await buildGoogleApp()
      const { sid } = await authorizeInit(app)
      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/exchange',
        payload: { sid, code: 'c', state: 'attacker-state-value-yyyyy' },
      })
      expect(res.statusCode).toBe(401)
      expect((res.json() as ProblemResponse).code).toBe('AUTH_STATE_MISMATCH')
    })

    it('returns 401 AUTH_EMAIL_UNVERIFIED when email_verified=false (spec §13.5)', async () => {
      app = await buildGoogleApp()
      const { sid, authUrl } = await authorizeInit(app)
      const nonce = extractAuthParam(authUrl, 'nonce')
      const state = extractAuthParam(authUrl, 'state')
      const idToken = google.signIdToken(
        defaultIdTokenPayload({
          nonce,
          sub: 'sub-unverified',
          email: 'unverified@example.com',
          emailVerified: false,
        }),
      )
      google.enqueueTokenResponse(idToken)
      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/exchange',
        payload: { sid, code: 'c', state },
      })
      expect(res.statusCode).toBe(401)
      expect((res.json() as ProblemResponse).code).toBe('AUTH_EMAIL_UNVERIFIED')
    })

    it('returns 401 AUTH_ID_TOKEN_INVALID when ID token nonce does not match', async () => {
      app = await buildGoogleApp()
      const { sid, authUrl } = await authorizeInit(app)
      const state = extractAuthParam(authUrl, 'state')
      const idToken = google.signIdToken(
        defaultIdTokenPayload({
          nonce: 'attacker-supplied-nonce',
          sub: 'sub-bad-nonce',
          email: 'bad@example.com',
        }),
      )
      google.enqueueTokenResponse(idToken)
      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/exchange',
        payload: { sid, code: 'c', state },
      })
      expect(res.statusCode).toBe(401)
      expect((res.json() as ProblemResponse).code).toBe('AUTH_ID_TOKEN_INVALID')
    })

    it('returns 409 AUTH_EMAIL_OWNED_BY_OTHER_ACCOUNT when email is already used by another account (spec §10.5)', async () => {
      app = await buildGoogleApp()
      // Seed an account that owns the email but has NO google credential.
      await app.prisma.account.create({ data: { email: 'taken@example.com' } })

      const { sid, authUrl } = await authorizeInit(app)
      const nonce = extractAuthParam(authUrl, 'nonce')
      const state = extractAuthParam(authUrl, 'state')
      const idToken = google.signIdToken(
        defaultIdTokenPayload({
          nonce,
          sub: 'sub-fresh',
          email: 'taken@example.com',
        }),
      )
      google.enqueueTokenResponse(idToken)
      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/exchange',
        payload: { sid, code: 'c', state },
      })
      expect(res.statusCode).toBe(409)
      expect((res.json() as ProblemResponse).code).toBe('AUTH_EMAIL_OWNED_BY_OTHER_ACCOUNT')
    })

    it('returns 502 UPSTREAM_FAILURE when Google /token responds with 5xx', async () => {
      app = await buildGoogleApp()
      const { sid, authUrl } = await authorizeInit(app)
      const state = extractAuthParam(authUrl, 'state')
      // Override the token handler with a 5xx response.
      server.use(
        http.post(GOOGLE_TOKEN_URL, () => new HttpResponse('boom', { status: 503 })),
      )
      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/exchange',
        payload: { sid, code: 'c', state },
      })
      expect(res.statusCode).toBe(504)
      // GatewayTimeoutError defaults to UPSTREAM_FAILURE per service mapping.
      const code = (res.json() as ProblemResponse).code
      expect(['UPSTREAM_FAILURE', 'UPSTREAM_TIMEOUT', 'GATEWAY_TIMEOUT']).toContain(code)
    })
  })

  // ── /exchange (link intent, spec §10.6) ─────────────────────────────────
  describe('POST /auth/google/exchange (link intent)', () => {
    async function registerAndGetTokens(
      instance: FastifyInstance,
      email: string,
      password: string,
    ): Promise<TokenBundleResponse> {
      const reg = await instance.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email, password },
      })
      expect(reg.statusCode).toBe(201)
      return reg.json() as TokenBundleResponse
    }

    it('links a Google credential to the currently authenticated account (204)', async () => {
      app = await buildGoogleApp()
      const tokens = await registerAndGetTokens(app, 'linker@example.com', 'pw-link-123456')

      const { sid, authUrl } = await authorizeInit(app, {
        intent: 'link',
        accessToken: tokens.accessToken,
      })
      const nonce = extractAuthParam(authUrl, 'nonce')
      const state = extractAuthParam(authUrl, 'state')
      const idToken = google.signIdToken(
        defaultIdTokenPayload({
          nonce,
          sub: 'sub-to-link',
          email: 'g-account@example.com',
        }),
      )
      google.enqueueTokenResponse(idToken)
      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/exchange',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        payload: { sid, code: 'c', state },
      })
      expect(res.statusCode).toBe(204)

      const cred = await app.prisma.googleCredential.findUnique({
        where: { externalId: 'sub-to-link' },
      })
      expect(cred?.email).toBe('g-account@example.com')
    })

    // ── spec 007 §10.2 — link is NOT a login event ──
    it('link intent does NOT touch lastLoginAt (caller was already logged in via password)', async () => {
      app = await buildGoogleApp()
      const tokens = await registerAndGetTokens(app, 'audit-link@example.com', 'pw-link-aud-1')
      const decoded = decodeJwtUnsafe(tokens.accessToken)
      const accountId = decoded.sub as string

      const beforeAccount = await app.prisma.account.findUnique({ where: { id: accountId } })
      const tsBefore = beforeAccount?.lastLoginAt?.getTime() ?? 0
      expect(beforeAccount?.lastLoginType).toBe('PASSWORD')

      await new Promise((r) => setTimeout(r, 10))

      const { sid, authUrl } = await authorizeInit(app, {
        intent: 'link',
        accessToken: tokens.accessToken,
      })
      const nonce = extractAuthParam(authUrl, 'nonce')
      const state = extractAuthParam(authUrl, 'state')
      const idToken = google.signIdToken(
        defaultIdTokenPayload({
          nonce,
          sub: 'sub-audit-link',
          email: 'g-audit-link@example.com',
        }),
      )
      google.enqueueTokenResponse(idToken)
      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/exchange',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        payload: { sid, code: 'c', state },
      })
      expect(res.statusCode).toBe(204)

      const afterAccount = await app.prisma.account.findUnique({ where: { id: accountId } })
      expect(afterAccount?.lastLoginType).toBe('PASSWORD') // unchanged
      expect(afterAccount?.lastLoginAt?.getTime() ?? 0).toBe(tsBefore)
    })

    it('rejects link when the Google sub is already linked to another account (409 AUTH_GOOGLE_ALREADY_LINKED)', async () => {
      app = await buildGoogleApp()
      // Seed another account that already owns the Google sub.
      await app.prisma.account.create({
        data: {
          email: 'owner@example.com',
          googleCredential: { create: { externalId: 'sub-owned', email: 'owner@example.com' } },
        },
      })
      const tokens = await registerAndGetTokens(app, 'linker2@example.com', 'pw-link-654321')

      const { sid, authUrl } = await authorizeInit(app, {
        intent: 'link',
        accessToken: tokens.accessToken,
      })
      const nonce = extractAuthParam(authUrl, 'nonce')
      const state = extractAuthParam(authUrl, 'state')
      const idToken = google.signIdToken(
        defaultIdTokenPayload({ nonce, sub: 'sub-owned', email: 'g@example.com' }),
      )
      google.enqueueTokenResponse(idToken)
      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/exchange',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        payload: { sid, code: 'c', state },
      })
      expect(res.statusCode).toBe(409)
      expect((res.json() as ProblemResponse).code).toBe('AUTH_GOOGLE_ALREADY_LINKED')
    })

    it('rejects link when the current account already has a Google credential (409 AUTH_CREDENTIAL_EXISTS)', async () => {
      app = await buildGoogleApp()
      // Register a password account, then directly seed its google credential.
      const tokens = await registerAndGetTokens(app, 'dup@example.com', 'pw-dup-123456')
      const decoded = decodeJwtUnsafe(tokens.accessToken)
      await app.prisma.googleCredential.create({
        data: {
          accountId: decoded.sub as string,
          externalId: 'sub-already-mine',
          email: 'dup@example.com',
        },
      })

      const { sid, authUrl } = await authorizeInit(app, {
        intent: 'link',
        accessToken: tokens.accessToken,
      })
      const nonce = extractAuthParam(authUrl, 'nonce')
      const state = extractAuthParam(authUrl, 'state')
      const idToken = google.signIdToken(
        defaultIdTokenPayload({ nonce, sub: 'sub-newish', email: 'g@example.com' }),
      )
      google.enqueueTokenResponse(idToken)
      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/exchange',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        payload: { sid, code: 'c', state },
      })
      expect(res.statusCode).toBe(409)
      expect((res.json() as ProblemResponse).code).toBe('AUTH_CREDENTIAL_EXISTS')
    })

    it('rejects link when the JWT accountId differs from the session accountId (401 AUTH_LINK_SESSION_MISMATCH)', async () => {
      app = await buildGoogleApp()
      const aliceTokens = await registerAndGetTokens(app, 'alice@example.com', 'pw-alice-12345')
      const bobTokens = await registerAndGetTokens(app, 'bob@example.com', 'pw-bob-12345678')

      // Alice initiates the link.
      const { sid, authUrl } = await authorizeInit(app, {
        intent: 'link',
        accessToken: aliceTokens.accessToken,
      })
      const nonce = extractAuthParam(authUrl, 'nonce')
      const state = extractAuthParam(authUrl, 'state')
      const idToken = google.signIdToken(
        defaultIdTokenPayload({ nonce, sub: 'sub-swap', email: 'swap@example.com' }),
      )
      google.enqueueTokenResponse(idToken)

      // Bob tries to complete it.
      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/exchange',
        headers: { authorization: `Bearer ${bobTokens.accessToken}` },
        payload: { sid, code: 'c', state },
      })
      expect(res.statusCode).toBe(401)
      expect((res.json() as ProblemResponse).code).toBe('AUTH_LINK_SESSION_MISMATCH')
    })
  })

  // ── /auth/refresh (spec §5 / §7.3) ──────────────────────────────────────
  describe('POST /auth/refresh', () => {
    async function freshTokens(instance: FastifyInstance): Promise<TokenBundleResponse> {
      const reg = await instance.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: `r-${Date.now()}@example.com`, password: 'pw-refresh-1234' },
      })
      expect(reg.statusCode).toBe(201)
      return reg.json() as TokenBundleResponse
    }

    it('rotates a valid refresh token into a fresh access + refresh bundle', async () => {
      app = await buildGoogleApp()
      const original = await freshTokens(app)
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { authorization: `Bearer ${original.refreshToken}` },
      })
      expect(res.statusCode).toBe(200)
      const next = res.json() as TokenBundleResponse
      expect(next.accessToken).not.toBe(original.accessToken)
      expect(next.refreshToken).not.toBe(original.refreshToken)
    })

    it('returns 401 AUTH_REFRESH_REPLAY when the same refresh token is presented twice (spec §5.1)', async () => {
      app = await buildGoogleApp()
      const original = await freshTokens(app)
      // First call rotates the token (marks used=true).
      const ok = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { authorization: `Bearer ${original.refreshToken}` },
      })
      expect(ok.statusCode).toBe(200)
      const next = ok.json() as TokenBundleResponse

      // Replay the original refresh — must trigger replay detection.
      const replay = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { authorization: `Bearer ${original.refreshToken}` },
      })
      expect(replay.statusCode).toBe(401)
      expect((replay.json() as ProblemResponse).code).toBe('AUTH_REFRESH_REPLAY')

      // Replay must ALSO revoke the rotated (new) refresh — spec §11.4.
      const followUp = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { authorization: `Bearer ${next.refreshToken}` },
      })
      expect(followUp.statusCode).toBe(401)
      expect((followUp.json() as ProblemResponse).code).toBe('AUTH_REFRESH_REVOKED')
    })

    it('two concurrent /auth/refresh with the same token: exactly one succeeds (spec §11.4 atomicity)', async () => {
      app = await buildGoogleApp()
      const original = await freshTokens(app)

      // Fire two requests in parallel. The atomic Lua consume must serialise
      // these so exactly one returns 200 and the OTHER must be flagged as
      // replay (NOT both succeed).
      const [a, b] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/auth/refresh',
          headers: { authorization: `Bearer ${original.refreshToken}` },
        }),
        app.inject({
          method: 'POST',
          url: '/auth/refresh',
          headers: { authorization: `Bearer ${original.refreshToken}` },
        }),
      ])

      const codes = [a.statusCode, b.statusCode].sort((x, y) => x - y)
      expect(codes).toEqual([200, 401])
      const loser = (a.statusCode === 200 ? b : a).json() as ProblemResponse
      expect(loser.code).toBe('AUTH_REFRESH_REPLAY')
    })

    it('returns 401 AUTH_REFRESH_REVOKED when the refresh JWT is unknown to Redis', async () => {
      app = await buildGoogleApp()
      const original = await freshTokens(app)
      // Flush Redis to simulate the record being missing.
      await app.redis.flushdb()
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { authorization: `Bearer ${original.refreshToken}` },
      })
      expect(res.statusCode).toBe(401)
      expect((res.json() as ProblemResponse).code).toBe('AUTH_REFRESH_REVOKED')
    })

    it('returns 401 when the Authorization header is missing', async () => {
      app = await buildGoogleApp()
      const res = await app.inject({ method: 'POST', url: '/auth/refresh' })
      expect(res.statusCode).toBe(401)
      expect((res.json() as ProblemResponse).code).toBe('UNAUTHORIZED')
    })
  })

  // ── /auth/logout (spec §6 / §7.4) ───────────────────────────────────────
  describe('POST /auth/logout & /auth/logout-all', () => {
    async function freshTokens(instance: FastifyInstance): Promise<TokenBundleResponse> {
      const reg = await instance.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: `l-${Date.now()}@example.com`, password: 'pw-logout-12345' },
      })
      expect(reg.statusCode).toBe(201)
      return reg.json() as TokenBundleResponse
    }

    it('logout returns 204 and revokes the supplied refresh token', async () => {
      app = await buildGoogleApp()
      const tokens = await freshTokens(app)
      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        payload: { refreshToken: tokens.refreshToken },
      })
      expect(res.statusCode).toBe(204)

      // The same refresh must no longer work.
      const after = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { authorization: `Bearer ${tokens.refreshToken}` },
      })
      expect(after.statusCode).toBe(401)
    })

    it('logout-all returns 204 and revokes every refresh token for the account', async () => {
      app = await buildGoogleApp()
      const tokensA = await freshTokens(app)
      // Mint a second refresh via rotation.
      const rotated = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { authorization: `Bearer ${tokensA.refreshToken}` },
      })
      expect(rotated.statusCode).toBe(200)
      const tokensB = rotated.json() as TokenBundleResponse

      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout-all',
        headers: { authorization: `Bearer ${tokensB.accessToken}` },
      })
      expect(res.statusCode).toBe(204)

      const after = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { authorization: `Bearer ${tokensB.refreshToken}` },
      })
      expect(after.statusCode).toBe(401)
    })

    it('logout returns 401 UNAUTHORIZED when no access token is supplied', async () => {
      app = await buildGoogleApp()
      const res = await app.inject({ method: 'POST', url: '/auth/logout', payload: {} })
      expect(res.statusCode).toBe(401)
      expect((res.json() as ProblemResponse).code).toBe('UNAUTHORIZED')
    })
  })
})
