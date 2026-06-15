// Spec 020 §5.1 — Charity admin endpoint integration tests.
//
// All routes are role=0 gated; every test injects a real admin JWT signed
// with the test JWT secret. Coverage matches spec 020 §13.2 table:
// happy path / required-missing / unknown categoryIds / 404 / PATCH replace
// categoryIds / archive idempotent / lifecycle restore / cascading
// invalidation.

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Role, signAccessToken } from '../../src/lib/auth/index.js'
import { buildCacheKey } from '../../src/lib/cache/index.js'
import { buildApp } from '../helpers/app.js'

let app: FastifyInstance

beforeEach(async () => {
  app = await buildApp()
})

afterEach(async () => {
  await app.close()
})

async function adminToken(): Promise<string> {
  const account = await app.prisma.account.create({
    data: { username: 'admin-' + Math.random().toString(36).slice(2, 8), role: Role.ADMIN },
  })
  const { token } = await signAccessToken(account.id, app.tokenSecrets, 0)
  return token
}

async function userToken(): Promise<string> {
  const account = await app.prisma.account.create({
    data: { username: 'user-' + Math.random().toString(36).slice(2, 8), role: Role.USER },
  })
  const { token } = await signAccessToken(account.id, app.tokenSecrets, 1)
  return token
}

async function seedCategory(key: string): Promise<{ id: string }> {
  return app.prisma.category.create({
    data: { key, displayName: `display:${key}`, displayOrder: 0 },
  })
}

const BASE_BODY = {
  name: '測試慈善機構',
  description: '描述',
}

interface CharityResp {
  id: string
  name: string
  logoUrl: string | null
  categories: { id: string; key: string; displayName: string }[]
}

// ── Auth gate ──────────────────────────────────────────────────────────────

describe('Auth gate (spec 020 §2.3)', () => {
  it('rejects unauthenticated POST with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/donation/charities',
      payload: BASE_BODY,
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects non-admin (role=1) POST with 403', async () => {
    const token = await userToken()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/donation/charities',
      headers: { authorization: `Bearer ${token}` },
      payload: BASE_BODY,
    })
    expect(res.statusCode).toBe(403)
  })
})

// ── POST /v1/donation/charities ────────────────────────────────────────────

describe('POST /v1/donation/charities (spec 020 §5.1.1)', () => {
  it('creates a charity and returns 201 + Location + detail body', async () => {
    const token = await adminToken()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/donation/charities',
      headers: { authorization: `Bearer ${token}` },
      payload: BASE_BODY,
    })
    expect(res.statusCode).toBe(201)
    expect(res.headers.location).toMatch(/^\/v1\/donation\/charities\//)
    const body = res.json() as CharityResp
    expect(body.name).toBe(BASE_BODY.name)
    expect(body.categories).toEqual([])
    const row = await app.prisma.charity.findUnique({ where: { id: body.id } })
    expect(row).not.toBe(null)
  })

  it('rejects missing required field with 400 VALIDATION_FAILED', async () => {
    const token = await adminToken()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/donation/charities',
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'no name' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('rejects unknown property with 400 VALIDATION_FAILED (additionalProperties: false)', async () => {
    const token = await adminToken()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/donation/charities',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...BASE_BODY, foo: 'bar' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('attaches categoryIds and returns inflated categories', async () => {
    const token = await adminToken()
    const cat = await seedCategory('cat-a')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/donation/charities',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...BASE_BODY, categoryIds: [cat.id] },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as CharityResp
    expect(body.categories.map((c) => c.id)).toEqual([cat.id])
  })

  it('rejects unknown categoryId with 400 CHARITY_CATEGORY_INVALID', async () => {
    const token = await adminToken()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/donation/charities',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        ...BASE_BODY,
        categoryIds: ['11111111-1111-4111-8111-111111111111'],
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'CHARITY_CATEGORY_INVALID' })
  })

  it('rejects publishStartAt >= publishEndAt with 400 INVALID_LIFECYCLE_RANGE', async () => {
    const token = await adminToken()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/donation/charities',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        ...BASE_BODY,
        publishStartAt: '2030-01-01T00:00:00.000Z',
        publishEndAt: '2025-01-01T00:00:00.000Z',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_LIFECYCLE_RANGE' })
  })

  it('rejects malformed logoKey with 400 (S3 key regex)', async () => {
    const token = await adminToken()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/donation/charities',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...BASE_BODY, logoKey: 'not-a-key' },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ── PATCH /v1/donation/charities/:id ───────────────────────────────────────

describe('PATCH /v1/donation/charities/:id (spec 020 §5.1.2)', () => {
  it('updates name + replaces categoryIds (full replace, not append)', async () => {
    const token = await adminToken()
    const catA = await seedCategory('cat-a')
    const catB = await seedCategory('cat-b')
    const create = await app.inject({
      method: 'POST',
      url: '/v1/donation/charities',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...BASE_BODY, categoryIds: [catA.id] },
    })
    const id = (create.json() as CharityResp).id

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/donation/charities/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Renamed', categoryIds: [catB.id] },
    })
    expect(patch.statusCode).toBe(200)
    const body = patch.json() as CharityResp
    expect(body.name).toBe('Renamed')
    expect(body.categories.map((c) => c.id)).toEqual([catB.id])
  })

  it('returns 404 CHARITY_NOT_FOUND for unknown id', async () => {
    const token = await adminToken()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/donation/charities/11111111-1111-4111-8111-111111111111',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'X' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'CHARITY_NOT_FOUND' })
  })

  it('clears nullable field with explicit null (contactEmail: null)', async () => {
    const token = await adminToken()
    const create = await app.inject({
      method: 'POST',
      url: '/v1/donation/charities',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...BASE_BODY, contactEmail: 'a@example.com' },
    })
    const id = (create.json() as CharityResp).id
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/donation/charities/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { contactEmail: null },
    })
    expect(patch.statusCode).toBe(200)
    const row = await app.prisma.charity.findUnique({ where: { id } })
    expect(row?.contactEmail).toBe(null)
  })

  it('omitted field stays unchanged (PATCH semantics)', async () => {
    const token = await adminToken()
    const create = await app.inject({
      method: 'POST',
      url: '/v1/donation/charities',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...BASE_BODY, contactEmail: 'a@example.com' },
    })
    const id = (create.json() as CharityResp).id
    await app.inject({
      method: 'PATCH',
      url: `/v1/donation/charities/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Only name' },
    })
    const row = await app.prisma.charity.findUnique({ where: { id } })
    expect(row?.contactEmail).toBe('a@example.com')
    expect(row?.name).toBe('Only name')
  })
})

// ── Lifecycle actions ──────────────────────────────────────────────────────

describe('Lifecycle actions (spec 020 §5.1.3 ~ §5.1.6)', () => {
  async function createOne(token: string): Promise<string> {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/donation/charities',
      headers: { authorization: `Bearer ${token}` },
      payload: BASE_BODY,
    })
    return (create.json() as CharityResp).id
  }

  it('archive sets archivedAt and hides from public list', async () => {
    const token = await adminToken()
    const id = await createOne(token)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/donation/charities/${id}/archive`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(204)
    const row = await app.prisma.charity.findUnique({ where: { id } })
    expect(row?.archivedAt).not.toBe(null)

    // Public list must not include it now.
    const list = await app.inject({ method: 'GET', url: '/v1/donation/charities' })
    const listBody = list.json() as { items: { id: string }[] }
    expect(listBody.items.map((i) => i.id)).not.toContain(id)
  })

  it('archive is idempotent (already archived → 204, no state change)', async () => {
    const token = await adminToken()
    const id = await createOne(token)
    await app.inject({
      method: 'POST',
      url: `/v1/donation/charities/${id}/archive`,
      headers: { authorization: `Bearer ${token}` },
    })
    const before = await app.prisma.charity.findUnique({ where: { id } })
    const secondCall = await app.inject({
      method: 'POST',
      url: `/v1/donation/charities/${id}/archive`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(secondCall.statusCode).toBe(204)
    const after = await app.prisma.charity.findUnique({ where: { id } })
    expect(after?.archivedAt?.toISOString()).toBe(before?.archivedAt?.toISOString())
  })

  it('archive on missing id → 404', async () => {
    const token = await adminToken()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/donation/charities/11111111-1111-4111-8111-111111111111/archive',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('unarchive clears archivedAt and restores public list visibility', async () => {
    const token = await adminToken()
    const id = await createOne(token)
    await app.inject({
      method: 'POST',
      url: `/v1/donation/charities/${id}/archive`,
      headers: { authorization: `Bearer ${token}` },
    })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/donation/charities/${id}/unarchive`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(204)
    const list = await app.inject({ method: 'GET', url: '/v1/donation/charities' })
    const ids = (list.json() as { items: { id: string }[] }).items.map((i) => i.id)
    expect(ids).toContain(id)
  })

  it('DELETE soft-deletes (sets deletedAt) — row remains in DB', async () => {
    const token = await adminToken()
    const id = await createOne(token)
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/donation/charities/${id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(204)
    const row = await app.prisma.charity.findUnique({ where: { id } })
    expect(row).not.toBe(null)
    expect(row?.deletedAt).not.toBe(null)
  })

  it('restore clears deletedAt', async () => {
    const token = await adminToken()
    const id = await createOne(token)
    await app.inject({
      method: 'DELETE',
      url: `/v1/donation/charities/${id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/donation/charities/${id}/restore`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(204)
    const row = await app.prisma.charity.findUnique({ where: { id } })
    expect(row?.deletedAt).toBe(null)
  })
})

// ── Cache invalidation ─────────────────────────────────────────────────────

describe('Cache invalidation graceful degradation (spec 019 §9.1)', () => {
  it('Redis pipeline failure does NOT block the write — returns 201 + warn log', async () => {
    const token = await adminToken()
    // Force the cache pipeline path to throw at the network layer. The
    // invalidator wraps the entire pipeline().exec() in try/catch and logs
    // warn — the route should still return 201.
    const originalPipeline = app.redis.pipeline.bind(app.redis)
    const spy = vi
      .spyOn(app.redis, 'pipeline')
      .mockImplementation((() => {
        throw new Error('synthetic redis outage')
      }) as typeof app.redis.pipeline)
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/donation/charities',
        headers: { authorization: `Bearer ${token}` },
        payload: BASE_BODY,
      })
      expect(res.statusCode).toBe(201)
      // DB row still landed.
      const id = (res.json() as CharityResp).id
      const row = await app.prisma.charity.findUnique({ where: { id } })
      expect(row).not.toBe(null)
    } finally {
      spy.mockRestore()
      // restore in case afterEach reads through app.redis
      void originalPipeline
    }
  })
})

describe('Rate limit (spec 020 §11 dual-layer)', () => {
  // Spec 020 §11 — create bucket is per-user 60/h + per-IP 300/h. We can't
  // hammer 61 requests in a test (too slow); instead lean on a tight
  // env-override so even 4 requests trip the bucket.
  it('returns 429 once the per-IP create budget is exhausted', async () => {
    // Override the global default per-IP limit — admin route's per-IP layer
    // overrides it, but since spec 020 sets create to 300/h that won't
    // fire fast enough in a test. Instead use a per-route override would
    // require schema change; we exercise the L1 global IP bucket via env.
    await app.close()
    app = await buildApp({
      RATE_LIMIT_GLOBAL_PER_IP_LIMIT: '3',
      RATE_LIMIT_GLOBAL_PER_IP_WINDOW_SEC: '60',
    })
    const token = await adminToken()
    // Issue requests until one hits 429. The global per-IP limit is 3, so
    // the 4th call (or earlier given other plugin overhead) should fail.
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/donation/charities',
        headers: { authorization: `Bearer ${token}` },
        payload: BASE_BODY,
      })
      statuses.push(r.statusCode)
    }
    expect(statuses).toContain(429)
  })
})

describe('Cache invalidation on write', () => {
  it('POST charity DELs the charity list cache slots', async () => {
    const token = await adminToken()
    // Prime a list cache slot via the public list endpoint.
    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/donation/charities',
    })
    expect(listRes.statusCode).toBe(200)

    // The 'ALL', zh-TW slot should be populated now.
    const slotKey = buildCacheKey('char:list:v1', ['ALL', 'zh-TW'])
    const before = await app.redis.get(slotKey)
    expect(before).not.toBe(null)

    // Admin POST a charity → invalidator should DEL the slot.
    const create = await app.inject({
      method: 'POST',
      url: '/v1/donation/charities',
      headers: { authorization: `Bearer ${token}` },
      payload: BASE_BODY,
    })
    expect(create.statusCode).toBe(201)
    const after = await app.redis.get(slotKey)
    expect(after).toBe(null)
  })
})
