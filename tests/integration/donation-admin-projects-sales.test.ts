// Spec 020 §5.2 / §5.3 — DonationProject + SaleItem admin endpoint
// integration tests. Charity tests cover the shared pattern exhaustively
// (charity-write / lifecycle / cache invalidate); these two suites focus
// on entity-specific behaviour:
//
//   Project:   parent Charity FK required + archived parent allowed
//   SaleItem:  +required priceTwd + range check
//
// The same auth gate / unknown-property rejection / lifecycle idempotency
// would just duplicate Charity tests — we trust the shared helpers and
// only exercise the entity-specific deltas here.

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

async function seedCharity(over: { archivedAt?: Date | null } = {}): Promise<{ id: string }> {
  return app.prisma.charity.create({
    data: {
      name: '本機構',
      description: 'd',
      archivedAt: over.archivedAt ?? null,
    },
    select: { id: true },
  })
}

interface ProjResp {
  id: string
  name: string
  charity: { id: string }
}

interface SaleResp {
  id: string
  name: string
  priceTwd: number
  charity: { id: string }
}

// ── DonationProject ────────────────────────────────────────────────────────

describe('POST /v1/donation/donation-projects (spec 020 §5.2)', () => {
  it('creates with required parent charityId; returns 201 + nested charity', async () => {
    const token = await adminToken()
    const charity = await seedCharity()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/donation/donation-projects',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        charityId: charity.id,
        name: 'P',
        description: 'd',
        content: 'c',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as ProjResp
    expect(body.charity.id).toBe(charity.id)
  })

  it('returns 404 CHARITY_NOT_FOUND when parent charity does not exist', async () => {
    const token = await adminToken()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/donation/donation-projects',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        charityId: '11111111-1111-4111-8111-111111111111',
        name: 'P',
        description: 'd',
        content: 'c',
      },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'CHARITY_NOT_FOUND' })
  })

  it('allows creating a project under an archived charity (spec 020 §5.2 admin workflow)', async () => {
    const token = await adminToken()
    const charity = await seedCharity({ archivedAt: new Date() })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/donation/donation-projects',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        charityId: charity.id,
        name: 'P',
        description: 'd',
        content: 'c',
      },
    })
    expect(res.statusCode).toBe(201)
  })

  it('PATCH cannot change charityId (additionalProperties: false)', async () => {
    const token = await adminToken()
    const charityA = await seedCharity()
    const create = await app.inject({
      method: 'POST',
      url: '/v1/donation/donation-projects',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        charityId: charityA.id,
        name: 'P',
        description: 'd',
        content: 'c',
      },
    })
    const id = (create.json() as ProjResp).id
    const charityB = await seedCharity()
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/donation/donation-projects/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { charityId: charityB.id },
    })
    expect(patch.statusCode).toBe(400)
  })

  it('lifecycle archive → public list hides the row', async () => {
    const token = await adminToken()
    const charity = await seedCharity()
    const create = await app.inject({
      method: 'POST',
      url: '/v1/donation/donation-projects',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        charityId: charity.id,
        name: 'P',
        description: 'd',
        content: 'c',
      },
    })
    const id = (create.json() as ProjResp).id
    await app.inject({
      method: 'POST',
      url: `/v1/donation/donation-projects/${id}/archive`,
      headers: { authorization: `Bearer ${token}` },
    })
    const list = await app.inject({
      method: 'GET',
      url: '/v1/donation/donation-projects',
    })
    const ids = (list.json() as { items: { id: string }[] }).items.map((i) => i.id)
    expect(ids).not.toContain(id)
  })
})

// ── SaleItem ───────────────────────────────────────────────────────────────

describe('POST /v1/donation/sale-items (spec 020 §5.3)', () => {
  it('creates with required priceTwd; returns nested charity', async () => {
    const token = await adminToken()
    const charity = await seedCharity()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/donation/sale-items',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        charityId: charity.id,
        name: 'S',
        description: 'd',
        content: 'c',
        priceTwd: 999,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as SaleResp
    expect(body.priceTwd).toBe(999)
    expect(body.charity.id).toBe(charity.id)
  })

  it('rejects missing priceTwd with 400', async () => {
    const token = await adminToken()
    const charity = await seedCharity()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/donation/sale-items',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        charityId: charity.id,
        name: 'S',
        description: 'd',
        content: 'c',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects negative priceTwd', async () => {
    const token = await adminToken()
    const charity = await seedCharity()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/donation/sale-items',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        charityId: charity.id,
        name: 'S',
        description: 'd',
        content: 'c',
        priceTwd: -1,
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('PATCH priceTwd updates the row', async () => {
    const token = await adminToken()
    const charity = await seedCharity()
    const create = await app.inject({
      method: 'POST',
      url: '/v1/donation/sale-items',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        charityId: charity.id,
        name: 'S',
        description: 'd',
        content: 'c',
        priceTwd: 100,
      },
    })
    const id = (create.json() as SaleResp).id
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/donation/sale-items/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { priceTwd: 250 },
    })
    expect(patch.statusCode).toBe(200)
    expect((patch.json() as SaleResp).priceTwd).toBe(250)
  })

  it('DELETE soft-deletes and restore reverses', async () => {
    const token = await adminToken()
    const charity = await seedCharity()
    const create = await app.inject({
      method: 'POST',
      url: '/v1/donation/sale-items',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        charityId: charity.id,
        name: 'S',
        description: 'd',
        content: 'c',
        priceTwd: 1,
      },
    })
    const id = (create.json() as SaleResp).id
    await app.inject({
      method: 'DELETE',
      url: `/v1/donation/sale-items/${id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    let row = await app.prisma.saleItem.findUnique({ where: { id } })
    expect(row?.deletedAt).not.toBe(null)
    await app.inject({
      method: 'POST',
      url: `/v1/donation/sale-items/${id}/restore`,
      headers: { authorization: `Bearer ${token}` },
    })
    row = await app.prisma.saleItem.findUnique({ where: { id } })
    expect(row?.deletedAt).toBe(null)
  })
})
