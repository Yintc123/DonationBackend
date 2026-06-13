// Spec 008 §13.2 — integration coverage of the email + password auth flow.
//
// buildApp() already registers `authPlugin` globally. Prisma + Redis
// are real testcontainers (FLUSHDB / TRUNCATE between tests, see
// tests/setup/per-test-setup.ts).
//
// Test cases trace directly to §13.2:
//   - /register  → 201 + tokens; duplicate email → 409 AUTH_EMAIL_TAKEN
//   - /login     → 200 + tokens; unknown email + bad password → 401
//                  AUTH_INVALID_CREDENTIALS (uniform path)
//   - per-email lock fires after threshold failures; correct password is
//     also rejected while locked
//   - /password/change requires bearer access token; wrong current → 401;
//     correct → 200 + fresh tokens

import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../helpers/app.js'

// Spec 008 §13.1 — production cost is too slow for tests; override per env.
const AUTH_TEST_ENV: Record<string, string> = {
  PASSWORD_HASH_MEMORY_COST: '8192',
  PASSWORD_HASH_TIME_COST: '2',
  PASSWORD_HASH_PARALLELISM: '1',
  PASSWORD_MIN_LENGTH: '8',
  LOGIN_LOCK_THRESHOLD: '3',
  LOGIN_LOCK_WINDOW_SEC: '900',
  // Generous rate limits so the per-IP layers don't trip when a single test
  // makes many login attempts back-to-back.
  RATE_LIMIT_GLOBAL_PER_IP_LIMIT: '10000',
  RATE_LIMIT_GLOBAL_PER_IP_WINDOW_SEC: '60',
  RATE_LIMIT_DEFAULT_LIMIT: '10000',
  RATE_LIMIT_DEFAULT_WINDOW_SEC: '60',
}

async function buildAuthApp(
  envOverrides: Record<string, string> = {},
): Promise<FastifyInstance> {
  const app = await buildApp({ ...AUTH_TEST_ENV, ...envOverrides })
  await app.ready()
  return app
}

interface TokenBundleResponse {
  accessToken: string
  accessExpiresIn: number
  refreshToken: string
  refreshExpiresIn: number
  tokenType: 'Bearer'
}

interface ProblemResponse {
  code: string
  status: number
  title: string
}

describe('auth/password integration (spec 008 §13.2)', () => {
  let app: FastifyInstance | undefined
  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // ── /register ───────────────────────────────────────────────────────────
  describe('POST /auth/register', () => {
    it('creates an account and returns access + refresh tokens', async () => {
      app = await buildAuthApp()

      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'Alice@Example.com', password: 'correct-horse-stable' },
      })

      expect(res.statusCode).toBe(201)
      const body = res.json() as TokenBundleResponse
      expect(body.tokenType).toBe('Bearer')
      expect(typeof body.accessToken).toBe('string')
      expect(typeof body.refreshToken).toBe('string')
      expect(body.accessExpiresIn).toBeGreaterThan(0)
      expect(body.refreshExpiresIn).toBeGreaterThan(0)

      // The account row is stored with the lowercased email.
      const stored = await app.prisma.account.findUnique({ where: { email: 'alice@example.com' } })
      expect(stored).not.toBeNull()
      const cred = await app.prisma.passwordCredential.findUnique({
        where: { accountId: stored!.id },
      })
      expect(cred?.hashAlgo).toBe('argon2id')
      expect(cred?.hashedPassword).toMatch(/^\$argon2id\$/)
    })

    it('rejects duplicate email with 409 AUTH_EMAIL_TAKEN (RFC 7807)', async () => {
      app = await buildAuthApp()

      const first = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'bob@example.com', password: 'first-attempt-pw1' },
      })
      expect(first.statusCode).toBe(201)

      const dup = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'bob@example.com', password: 'second-attempt-pw' },
      })
      expect(dup.statusCode).toBe(409)
      expect(dup.headers['content-type']).toMatch(/application\/problem\+json/)
      const body = dup.json() as ProblemResponse
      expect(body.code).toBe('AUTH_EMAIL_TAKEN')
    })

    it('rejects malformed bodies with 400 VALIDATION_FAILED', async () => {
      app = await buildAuthApp()
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'not-an-email', password: 'short' },
      })
      expect(res.statusCode).toBe(400)
      const body = res.json() as ProblemResponse
      expect(body.code).toBe('VALIDATION_FAILED')
    })
  })

  // ── /login ──────────────────────────────────────────────────────────────
  describe('POST /auth/login', () => {
    async function seedAccount(
      instance: FastifyInstance,
      email: string,
      password: string,
    ): Promise<void> {
      const res = await instance.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email, password },
      })
      expect(res.statusCode).toBe(201)
    }

    it('returns 200 + tokens for valid credentials', async () => {
      app = await buildAuthApp()
      await seedAccount(app, 'carol@example.com', 'rainbow-unicorn-7')

      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'Carol@Example.com', password: 'rainbow-unicorn-7' },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as TokenBundleResponse
      expect(body.tokenType).toBe('Bearer')
      expect(body.accessToken).toBeTruthy()
    })

    it('returns 401 AUTH_INVALID_CREDENTIALS when the email is unknown', async () => {
      app = await buildAuthApp()
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'ghost@example.com', password: 'any-password-here' },
      })
      expect(res.statusCode).toBe(401)
      const body = res.json() as ProblemResponse
      expect(body.code).toBe('AUTH_INVALID_CREDENTIALS')
    })

    it('returns 401 AUTH_INVALID_CREDENTIALS for wrong password', async () => {
      app = await buildAuthApp()
      await seedAccount(app, 'dave@example.com', 'matchstick-mast-79')

      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'dave@example.com', password: 'completely-wrong-pw' },
      })
      expect(res.statusCode).toBe(401)
      const body = res.json() as ProblemResponse
      expect(body.code).toBe('AUTH_INVALID_CREDENTIALS')
    })

    it('locks the account with AUTH_ACCOUNT_LOCKED after threshold failures', async () => {
      app = await buildAuthApp({ LOGIN_LOCK_THRESHOLD: '3' })
      await seedAccount(app, 'eve@example.com', 'the-right-passcode-9')

      // Three failed attempts trip the lock (count >= 3).
      for (let i = 0; i < 3; i++) {
        const r = await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email: 'eve@example.com', password: `wrong-pass-${i}-x` },
        })
        // The 3rd failure crosses the threshold and may surface AUTH_ACCOUNT_LOCKED.
        expect([401, 429]).toContain(r.statusCode)
      }

      // Even the correct password is now rejected while the lock holds.
      const locked = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'eve@example.com', password: 'the-right-passcode-9' },
      })
      expect(locked.statusCode).toBe(429)
      const body = locked.json() as ProblemResponse
      expect(body.code).toBe('AUTH_ACCOUNT_LOCKED')
    })

    it('resets the failure counter on a successful login', async () => {
      app = await buildAuthApp({ LOGIN_LOCK_THRESHOLD: '3' })
      await seedAccount(app, 'frank@example.com', 'the-real-pass-word-1')

      // Two failures (below threshold = 3).
      for (let i = 0; i < 2; i++) {
        await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email: 'frank@example.com', password: 'wrong-attempt-99' },
        })
      }
      // Successful login clears the counter.
      const ok = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'frank@example.com', password: 'the-real-pass-word-1' },
      })
      expect(ok.statusCode).toBe(200)

      // Two more bad attempts MUST NOT trip the lock (counter was reset).
      const bad1 = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'frank@example.com', password: 'still-wrong-aaa' },
      })
      const bad2 = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'frank@example.com', password: 'still-wrong-bbb' },
      })
      expect(bad1.statusCode).toBe(401)
      expect(bad2.statusCode).toBe(401)
    })
  })

  // ── /password/change ────────────────────────────────────────────────────
  describe('POST /auth/password/change', () => {
    it('rejects unauthenticated requests with 401 UNAUTHORIZED', async () => {
      app = await buildAuthApp()
      const res = await app.inject({
        method: 'POST',
        url: '/auth/password/change',
        payload: { currentPassword: 'old-password-aaaa', newPassword: 'new-password-bbbb' },
      })
      expect(res.statusCode).toBe(401)
      const body = res.json() as ProblemResponse
      expect(body.code).toBe('UNAUTHORIZED')
    })

    it('rejects wrong current password with 401 AUTH_INVALID_CREDENTIALS', async () => {
      app = await buildAuthApp()
      const reg = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'helen@example.com', password: 'first-known-pw-77' },
      })
      const { accessToken } = reg.json() as TokenBundleResponse

      const res = await app.inject({
        method: 'POST',
        url: '/auth/password/change',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          currentPassword: 'totally-wrong-oldp',
          newPassword: 'totally-new-passwordzz',
        },
      })
      expect(res.statusCode).toBe(401)
      const body = res.json() as ProblemResponse
      expect(body.code).toBe('AUTH_INVALID_CREDENTIALS')
    })

    it('rotates tokens and updates the credential on success', async () => {
      app = await buildAuthApp()
      const reg = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'ivan@example.com', password: 'original-passphrase-9' },
      })
      const { accessToken, refreshToken: originalRefresh } = reg.json() as TokenBundleResponse

      const res = await app.inject({
        method: 'POST',
        url: '/auth/password/change',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          currentPassword: 'original-passphrase-9',
          newPassword: 'brand-new-passphrase-7',
        },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as TokenBundleResponse
      expect(body.refreshToken).toBeTruthy()
      expect(body.refreshToken).not.toBe(originalRefresh)

      // The new password must work for login; the old one must not.
      const loginNew = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'ivan@example.com', password: 'brand-new-passphrase-7' },
      })
      expect(loginNew.statusCode).toBe(200)

      const loginOld = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'ivan@example.com', password: 'original-passphrase-9' },
      })
      expect(loginOld.statusCode).toBe(401)
    })
  })

  // ── /password/set ───────────────────────────────────────────────────────
  describe('POST /auth/password/set', () => {
    it('rejects accounts that already have a password with AUTH_PASSWORD_ALREADY_SET', async () => {
      app = await buildAuthApp()
      const reg = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'judy@example.com', password: 'the-original-passwd-1' },
      })
      const { accessToken } = reg.json() as TokenBundleResponse

      const res = await app.inject({
        method: 'POST',
        url: '/auth/password/set',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { newPassword: 'cannot-set-again-pw1' },
      })
      expect(res.statusCode).toBe(409)
      const body = res.json() as ProblemResponse
      expect(body.code).toBe('AUTH_PASSWORD_ALREADY_SET')
    })
  })
})
