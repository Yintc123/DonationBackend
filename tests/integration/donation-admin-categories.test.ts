// Spec 020 §5.4 — Category admin endpoint integration tests.
//
// Category is the dictionary table — no create endpoint (key is a TS
// const). Tests focus on the entity-specific behaviour vs the other three:
// the narrower PATCH whitelist (only displayName / displayNameEn /
// displayOrder) and the no-create policy.

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Role, signAccessToken } from '../../src/lib/auth/index.js'
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

async function seedCategory(over: Partial<{ key: string; displayName: string; displayNameEn: string | null; displayOrder: number }> = {}): Promise<{ id: string }> {
  return app.prisma.category.create({
    data: {
      key: over.key ?? 'cat-' + Math.random().toString(36).slice(2, 8),
      displayName: over.displayName ?? 'display',
      displayNameEn: over.displayNameEn ?? 'Display',
      displayOrder: over.displayOrder ?? 0,
    },
    select: { id: true },
  })
}

interface CatResp {
  id: string
  key: string
  displayName: string
  displayOrder: number
}

// ── Auth gate ──────────────────────────────────────────────────────────────

describe('Category admin auth gate', () => {
  it('rejects unauthenticated PATCH with 401', async () => {
    const cat = await seedCategory()
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/donation/categories/${cat.id}`,
      payload: { displayName: 'X' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects non-admin (role=1) with 403', async () => {
    const cat = await seedCategory()
    const token = await userToken()
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/donation/categories/${cat.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: 'X' },
    })
    expect(res.statusCode).toBe(403)
  })
})

// ── PATCH ──────────────────────────────────────────────────────────────────

describe('PATCH /v1/donation/categories/:id (spec 020 §5.4.1)', () => {
  it('updates displayName / displayNameEn / displayOrder', async () => {
    const token = await adminToken()
    const cat = await seedCategory()
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/donation/categories/${cat.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: '新分類', displayOrder: 99 },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as CatResp
    expect(body.displayName).toBe('新分類')
    expect(body.displayOrder).toBe(99)
  })

  it('rejects attempts to change key with 400 VALIDATION_FAILED', async () => {
    const token = await adminToken()
    const cat = await seedCategory()
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/donation/categories/${cat.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { key: 'tampered' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 404 NOT_FOUND for unknown id', async () => {
    const token = await adminToken()
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/donation/categories/11111111-1111-4111-8111-111111111111',
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: 'X' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('rejects unknown property (additionalProperties: false)', async () => {
    const token = await adminToken()
    const cat = await seedCategory()
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/donation/categories/${cat.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: 'X', archivedAt: '2030-01-01T00:00:00Z' },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ── Lifecycle ──────────────────────────────────────────────────────────────

describe('Category lifecycle actions', () => {
  it('archive + unarchive round-trip', async () => {
    const token = await adminToken()
    const cat = await seedCategory()
    const arch = await app.inject({
      method: 'POST',
      url: `/v1/donation/categories/${cat.id}/archive`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(arch.statusCode).toBe(204)
    let row = await app.prisma.category.findUnique({ where: { id: cat.id } })
    expect(row?.archivedAt).not.toBe(null)
    const unarch = await app.inject({
      method: 'POST',
      url: `/v1/donation/categories/${cat.id}/unarchive`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(unarch.statusCode).toBe(204)
    row = await app.prisma.category.findUnique({ where: { id: cat.id } })
    expect(row?.archivedAt).toBe(null)
  })

  it('DELETE soft + restore', async () => {
    const token = await adminToken()
    const cat = await seedCategory()
    await app.inject({
      method: 'DELETE',
      url: `/v1/donation/categories/${cat.id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    let row = await app.prisma.category.findUnique({ where: { id: cat.id } })
    expect(row?.deletedAt).not.toBe(null)
    await app.inject({
      method: 'POST',
      url: `/v1/donation/categories/${cat.id}/restore`,
      headers: { authorization: `Bearer ${token}` },
    })
    row = await app.prisma.category.findUnique({ where: { id: cat.id } })
    expect(row?.deletedAt).toBe(null)
  })

  it('archive on missing id → 404', async () => {
    const token = await adminToken()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/donation/categories/22222222-2222-4222-8222-222222222222/archive',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('archive idempotent (already archived → 204 no state change)', async () => {
    const token = await adminToken()
    const cat = await seedCategory()
    await app.inject({
      method: 'POST',
      url: `/v1/donation/categories/${cat.id}/archive`,
      headers: { authorization: `Bearer ${token}` },
    })
    const before = await app.prisma.category.findUnique({ where: { id: cat.id } })
    const second = await app.inject({
      method: 'POST',
      url: `/v1/donation/categories/${cat.id}/archive`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(second.statusCode).toBe(204)
    const after = await app.prisma.category.findUnique({ where: { id: cat.id } })
    expect(after?.archivedAt?.toISOString()).toBe(before?.archivedAt?.toISOString())
  })
})
