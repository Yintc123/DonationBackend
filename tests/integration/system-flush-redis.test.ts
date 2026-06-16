// Spec 025 §3.1 / §5 — integration tests for POST /cms/system/flush-redis.
//
// Real Redis (testcontainer) — we seed keys, call the endpoint, and assert
// DBSIZE = 0 afterwards. Auth path is the real /cms scope-level
// `requireAdmin` (spec 023 §4.4), so no JWT / wrong-role / archived cases
// each get their own branch.

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Role, signAccessToken, type TokenSecrets } from '../../src/lib/auth/index.js'
import { buildApp } from '../helpers/app.js'

let app: FastifyInstance

beforeEach(async () => {
  app = await buildApp()
})

afterEach(async () => {
  await app.close()
})

async function signFor(accountId: string, role: 0 | 1): Promise<string> {
  const secrets: TokenSecrets = app.tokenSecrets
  const { token } = await signAccessToken(accountId, secrets, role)
  return token
}

async function seedAdmin(): Promise<{ id: string; token: string }> {
  const account = await app.prisma.account.create({
    data: {
      username: 'admin-' + Math.random().toString(36).slice(2, 8),
      role: Role.ADMIN,
    },
  })
  return { id: account.id, token: await signFor(account.id, 0) }
}

async function seedUser(): Promise<{ id: string; token: string }> {
  const account = await app.prisma.account.create({
    data: {
      username: 'user-' + Math.random().toString(36).slice(2, 8),
      role: Role.USER,
    },
  })
  return { id: account.id, token: await signFor(account.id, 1) }
}

describe('POST /cms/system/flush-redis (spec 025 §3.1)', () => {
  it('admin + correct confirm: 200 + DBSIZE drops to 0', async () => {
    const admin = await seedAdmin()
    await app.redis.set('seed-1', 'v1')
    await app.redis.set('seed-2', 'v2')
    const before = await app.redis.dbsize()
    expect(before).toBeGreaterThanOrEqual(2)

    const res = await app.inject({
      method: 'POST',
      url: '/cms/system/flush-redis',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { confirm: 'FLUSH_ALL_REDIS_DATA' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { flushedKeyCount: number; durationMs: number }
    // Rate-limit / auth context also writes to redis during the inject call,
    // so the in-handler dbsize is >= our seeded count. Just sanity-check it
    // covered our seeds.
    expect(body.flushedKeyCount).toBeGreaterThanOrEqual(2)
    expect(typeof body.durationMs).toBe('number')
    expect(body.durationMs).toBeGreaterThanOrEqual(0)

    const after = await app.redis.dbsize()
    expect(after).toBe(0)
    expect(before).toBeGreaterThanOrEqual(2)
  })

  it('rejects 401 UNAUTHORIZED when no auth token is provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/cms/system/flush-redis',
      payload: { confirm: 'FLUSH_ALL_REDIS_DATA' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects 403 FORBIDDEN when the caller is a user (role=1)', async () => {
    const user = await seedUser()
    const res = await app.inject({
      method: 'POST',
      url: '/cms/system/flush-redis',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { confirm: 'FLUSH_ALL_REDIS_DATA' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejects 400 VALIDATION_FAILED when confirm field is missing', async () => {
    const admin = await seedAdmin()
    const res = await app.inject({
      method: 'POST',
      url: '/cms/system/flush-redis',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('rejects 400 VALIDATION_FAILED when confirm value is wrong', async () => {
    const admin = await seedAdmin()
    const res = await app.inject({
      method: 'POST',
      url: '/cms/system/flush-redis',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { confirm: 'wrong' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('rejects 400 VALIDATION_FAILED when body contains unknown fields', async () => {
    const admin = await seedAdmin()
    const res = await app.inject({
      method: 'POST',
      url: '/cms/system/flush-redis',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { confirm: 'FLUSH_ALL_REDIS_DATA', extra: 'oops' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('flushed Redis afterwards: existing keys really gone', async () => {
    const admin = await seedAdmin()
    await app.redis.set('a', '1')
    await app.redis.set('b', '2')
    const res = await app.inject({
      method: 'POST',
      url: '/cms/system/flush-redis',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { confirm: 'FLUSH_ALL_REDIS_DATA' },
    })
    expect(res.statusCode).toBe(200)
    expect(await app.redis.get('a')).toBe(null)
    expect(await app.redis.get('b')).toBe(null)
  })

  // Audit event `system_redis_flushed` (spec 025 §3.1.3) — emission is
  // verified by code review, not logger spy. Consistent with how other
  // audit events in this codebase (order_payment_confirmed, order_cancelled,
  // donation_*_archived, etc.) are tested — no logger spy infrastructure
  // exists, and we don't add one just for this endpoint.
})
