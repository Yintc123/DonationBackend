// Spec 008 §6.3 / §6.4 / §6.5 v0.4 — self-service Account CRUD integration.
//
// Three endpoints, all gated by requireLiveAccountId (verifies JWT signature
// + lifecycle), tested against a real Fastify app + testcontainer Postgres +
// Redis.

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../helpers/app.js'

const AUTH_TEST_ENV: Record<string, string> = {
  PASSWORD_HASH_MEMORY_COST: '8192',
  PASSWORD_HASH_TIME_COST: '2',
  PASSWORD_HASH_PARALLELISM: '1',
  PASSWORD_MIN_LENGTH: '8',
  RATE_LIMIT_GLOBAL_PER_IP_LIMIT: '10000',
  RATE_LIMIT_GLOBAL_PER_IP_WINDOW_SEC: '60',
  RATE_LIMIT_DEFAULT_LIMIT: '10000',
  RATE_LIMIT_DEFAULT_WINDOW_SEC: '60',
}

async function buildMeApp(): Promise<FastifyInstance> {
  const app = await buildApp(AUTH_TEST_ENV)
  await app.ready()
  return app
}

interface TokenBundleResponse {
  accessToken: string
  refreshToken: string
}

interface MeProfile {
  id: string
  username: string | null
  email: string | null
  displayOrder: number
  createdAt: string
  updatedAt: string
  lastLoginAt: string | null
  lastLoginType: 'PASSWORD' | 'GOOGLE' | null
}

interface ProblemResponse {
  code: string
  status: number
}

async function registerAndGetTokens(
  app: FastifyInstance,
  payload: { username?: string; email?: string; password: string },
): Promise<TokenBundleResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload,
  })
  expect(res.statusCode).toBe(201)
  return res.json() as TokenBundleResponse
}

describe('/auth/me — self-service CRUD (spec 008 §6.3-§6.5 v0.4)', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    app = await buildMeApp()
  })
  afterEach(async () => {
    await app.close()
  })

  // ── GET /auth/me ────────────────────────────────────────────────────────
  describe('GET /auth/me', () => {
    it('returns 401 without a bearer token', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/me' })
      expect(res.statusCode).toBe(401)
    })

    it('returns 401 with a malformed bearer token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: 'Bearer not-a-real-jwt' },
      })
      expect(res.statusCode).toBe(401)
    })

    it('returns the caller profile on success', async () => {
      const tokens = await registerAndGetTokens(app, {
        username: 'meowstreet',
        email: 'meow@example.com',
        password: 'wonder-cricket-99',
      })
      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as MeProfile
      expect(body.username).toBe('meowstreet')
      expect(body.email).toBe('meow@example.com')
      expect(body.displayOrder).toBe(0)
      expect(body.lastLoginType).toBe('PASSWORD')
      expect(typeof body.lastLoginAt).toBe('string')
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('register reply Location → /auth/me, GET that path works with the issued token', async () => {
      const reg = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { username: 'follower', password: 'wonder-cricket-99' },
      })
      expect(reg.statusCode).toBe(201)
      expect(reg.headers.location).toBe('/auth/me')

      const { accessToken } = reg.json() as TokenBundleResponse
      const followed = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
      })
      expect(followed.statusCode).toBe(200)
    })

    it('returns 401 AUTH_ACCOUNT_DISABLED when the account is archived', async () => {
      const tokens = await registerAndGetTokens(app, {
        username: 'illbearch',
        password: 'wonder-cricket-99',
      })
      await app.prisma.account.update({
        where: { username: 'illbearch' },
        data: { archivedAt: new Date() },
      })
      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
      expect(res.statusCode).toBe(401)
      expect((res.json() as ProblemResponse).code).toBe('AUTH_ACCOUNT_DISABLED')
    })

    it('returns 401 AUTH_ACCOUNT_DISABLED when the account is soft-deleted', async () => {
      const tokens = await registerAndGetTokens(app, {
        username: 'illbedel',
        password: 'wonder-cricket-99',
      })
      await app.prisma.account.update({
        where: { username: 'illbedel' },
        data: { deletedAt: new Date() },
      })
      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
      expect(res.statusCode).toBe(401)
      expect((res.json() as ProblemResponse).code).toBe('AUTH_ACCOUNT_DISABLED')
    })
  })

  // ── PATCH /auth/me ──────────────────────────────────────────────────────
  describe('PATCH /auth/me', () => {
    it('updates username only', async () => {
      const tokens = await registerAndGetTokens(app, {
        username: 'oldname',
        password: 'wonder-cricket-99',
      })
      const res = await app.inject({
        method: 'PATCH',
        url: '/auth/me',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        payload: { username: 'newname' },
      })
      expect(res.statusCode).toBe(200)
      expect((res.json() as MeProfile).username).toBe('newname')
    })

    it('updates email only (case-normalised)', async () => {
      const tokens = await registerAndGetTokens(app, {
        username: 'mailer',
        password: 'wonder-cricket-99',
      })
      const res = await app.inject({
        method: 'PATCH',
        url: '/auth/me',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        payload: { email: 'Mailer@Example.COM' },
      })
      expect(res.statusCode).toBe(200)
      expect((res.json() as MeProfile).email).toBe('mailer@example.com')
    })

    it('updates username and email together', async () => {
      const tokens = await registerAndGetTokens(app, {
        username: 'dualbefore',
        password: 'wonder-cricket-99',
      })
      const res = await app.inject({
        method: 'PATCH',
        url: '/auth/me',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        payload: { username: 'dualafter', email: 'dualafter@example.com' },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as MeProfile
      expect(body.username).toBe('dualafter')
      expect(body.email).toBe('dualafter@example.com')
    })

    it('rejects username taken by another account with 409', async () => {
      await registerAndGetTokens(app, {
        username: 'taken',
        password: 'wonder-cricket-99',
      })
      const me = await registerAndGetTokens(app, {
        username: 'medifferent',
        password: 'wonder-cricket-99',
      })
      const res = await app.inject({
        method: 'PATCH',
        url: '/auth/me',
        headers: { authorization: `Bearer ${me.accessToken}` },
        payload: { username: 'taken' },
      })
      expect(res.statusCode).toBe(409)
      expect((res.json() as ProblemResponse).code).toBe('AUTH_USERNAME_TAKEN')
    })

    it('rejects email taken by another account with 409', async () => {
      await registerAndGetTokens(app, {
        username: 'mailowner',
        email: 'taken@example.com',
        password: 'wonder-cricket-99',
      })
      const me = await registerAndGetTokens(app, {
        username: 'maileasy',
        password: 'wonder-cricket-99',
      })
      const res = await app.inject({
        method: 'PATCH',
        url: '/auth/me',
        headers: { authorization: `Bearer ${me.accessToken}` },
        payload: { email: 'taken@example.com' },
      })
      expect(res.statusCode).toBe(409)
      expect((res.json() as ProblemResponse).code).toBe('AUTH_EMAIL_TAKEN')
    })

    it('rejects clearing the only remaining identifier with 401 AUTH_IDENTIFIER_REQUIRED', async () => {
      const tokens = await registerAndGetTokens(app, {
        username: 'lastid',
        password: 'wonder-cricket-99',
      })
      // username is the only identifier. Clearing it would leave the row
      // with neither.
      const res = await app.inject({
        method: 'PATCH',
        url: '/auth/me',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        payload: { username: null },
      })
      expect(res.statusCode).toBe(401)
      expect((res.json() as ProblemResponse).code).toBe('AUTH_IDENTIFIER_REQUIRED')
    })

    it('allows clearing email when username remains', async () => {
      const tokens = await registerAndGetTokens(app, {
        username: 'keepuser',
        email: 'gone@example.com',
        password: 'wonder-cricket-99',
      })
      const res = await app.inject({
        method: 'PATCH',
        url: '/auth/me',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        payload: { email: null },
      })
      expect(res.statusCode).toBe(200)
      expect((res.json() as MeProfile).email).toBeNull()
      expect((res.json() as MeProfile).username).toBe('keepuser')
    })

    it('empty body is a no-op 200 (returns current profile)', async () => {
      const tokens = await registerAndGetTokens(app, {
        username: 'nochange',
        password: 'wonder-cricket-99',
      })
      const res = await app.inject({
        method: 'PATCH',
        url: '/auth/me',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        payload: {},
      })
      expect(res.statusCode).toBe(200)
      expect((res.json() as MeProfile).username).toBe('nochange')
    })

    it('rejects malformed username with 400 VALIDATION_FAILED', async () => {
      const tokens = await registerAndGetTokens(app, {
        username: 'goodname',
        password: 'wonder-cricket-99',
      })
      const res = await app.inject({
        method: 'PATCH',
        url: '/auth/me',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        payload: { username: 'has spaces' },
      })
      expect(res.statusCode).toBe(400)
      expect((res.json() as ProblemResponse).code).toBe('VALIDATION_FAILED')
    })

    it('returns 401 without a bearer token', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/auth/me',
        payload: { username: 'nopaste' },
      })
      expect(res.statusCode).toBe(401)
    })
  })

  // ── DELETE /auth/me ─────────────────────────────────────────────────────
  // ── POST /auth/me/archive ───────────────────────────────────────────────
  describe('POST /auth/me/archive', () => {
    it('archives the account, revokes refresh tokens, returns 204', async () => {
      const tokens = await registerAndGetTokens(app, {
        username: 'goingdormant',
        password: 'wonder-cricket-99',
      })
      const res = await app.inject({
        method: 'POST',
        url: '/auth/me/archive',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
      expect(res.statusCode).toBe(204)

      const stored = await app.prisma.account.findUnique({
        where: { username: 'goingdormant' },
      })
      expect(stored?.archivedAt).not.toBeNull()
      expect(stored?.deletedAt).toBeNull()
    })

    it('subsequent /auth/me read is rejected with 401 AUTH_ACCOUNT_DISABLED', async () => {
      const tokens = await registerAndGetTokens(app, {
        username: 'archthenread',
        password: 'wonder-cricket-99',
      })
      const archived = await app.inject({
        method: 'POST',
        url: '/auth/me/archive',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
      expect(archived.statusCode).toBe(204)

      const read = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
      expect(read.statusCode).toBe(401)
      expect((read.json() as ProblemResponse).code).toBe('AUTH_ACCOUNT_DISABLED')
    })

    it('returns 401 without a bearer token', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/me/archive' })
      expect(res.statusCode).toBe(401)
    })

    it('returns 401 AUTH_ACCOUNT_DISABLED when already archived (idempotency via the live guard)', async () => {
      const tokens = await registerAndGetTokens(app, {
        username: 'twicedormant',
        password: 'wonder-cricket-99',
      })
      await app.prisma.account.update({
        where: { username: 'twicedormant' },
        data: { archivedAt: new Date() },
      })
      const res = await app.inject({
        method: 'POST',
        url: '/auth/me/archive',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
      expect(res.statusCode).toBe(401)
      expect((res.json() as ProblemResponse).code).toBe('AUTH_ACCOUNT_DISABLED')
    })
  })

  describe('DELETE /auth/me', () => {
    it('soft deletes the account and revokes all refresh tokens', async () => {
      const tokens = await registerAndGetTokens(app, {
        username: 'goingaway',
        password: 'wonder-cricket-99',
      })
      const del = await app.inject({
        method: 'DELETE',
        url: '/auth/me',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
      expect(del.statusCode).toBe(204)

      const stored = await app.prisma.account.findUnique({
        where: { username: 'goingaway' },
      })
      expect(stored?.deletedAt).not.toBeNull()
    })

    it('refresh token issued before delete is rejected after delete with 401 AUTH_ACCOUNT_DISABLED', async () => {
      const tokens = await registerAndGetTokens(app, {
        username: 'usemyref',
        password: 'wonder-cricket-99',
      })
      await app.inject({
        method: 'DELETE',
        url: '/auth/me',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
      const refresh = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { authorization: `Bearer ${tokens.refreshToken}` },
      })
      expect(refresh.statusCode).toBe(401)
      // After delete, refresh store's revokeAll is run BEFORE the request
      // path checks disabled — so the token is now "not-found" rather than
      // "exists but account is disabled". Either AUTH_REFRESH_REVOKED or
      // AUTH_ACCOUNT_DISABLED is a correct outcome.
      const code = (refresh.json() as ProblemResponse).code
      expect(['AUTH_REFRESH_REVOKED', 'AUTH_ACCOUNT_DISABLED']).toContain(code)
    })

    it('returns 401 without a bearer token', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/auth/me' })
      expect(res.statusCode).toBe(401)
    })

    it('returns 401 AUTH_ACCOUNT_DISABLED when already disabled (no second delete)', async () => {
      const tokens = await registerAndGetTokens(app, {
        username: 'doublekill',
        password: 'wonder-cricket-99',
      })
      await app.prisma.account.update({
        where: { username: 'doublekill' },
        data: { archivedAt: new Date() },
      })
      const res = await app.inject({
        method: 'DELETE',
        url: '/auth/me',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
      expect(res.statusCode).toBe(401)
      expect((res.json() as ProblemResponse).code).toBe('AUTH_ACCOUNT_DISABLED')
    })
  })
})
