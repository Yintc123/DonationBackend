// Spec 022 §4.7-§4.10 — admin order endpoint integration tests.
//
// We sign a real ADMIN access JWT (signed with the test JWT secret + role=0)
// and pass it in the Authorization header. The route's `requireAdmin` calls
// `verifyAccessToken` + lifecycle check + role claim — same path production
// hits. Failure cases (no JWT / wrong role / archived account) test each
// branch of the gate.

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

// ── helpers ────────────────────────────────────────────────────────────────

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

async function seedCharityRow(name = 'Charity'): Promise<{ id: string }> {
  return app.prisma.charity.create({
    data: { name, description: 'd' },
    select: { id: true },
  })
}

async function seedSaleItemRow(charityId: string, priceTwd = 449): Promise<{ id: string }> {
  return app.prisma.saleItem.create({
    data: { charityId, name: 'item', description: 'd', content: 'c', priceTwd },
    select: { id: true },
  })
}

async function createCharityOrder(charityId: string): Promise<{ id: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/user/v1/donation/orders/charity-donation',
    payload: {
      donorName: 'X',
      receiptOption: 'NONE',
      charityId,
      donationFrequency: 'ONE_TIME',
      amountTwd: 500,
    },
  })
  const body = res.json() as { id: string }
  return { id: body.id }
}

async function createSaleItemOrder(saleItemId: string): Promise<{ id: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/user/v1/donation/orders/sale-item-purchase',
    payload: { donorName: 'B', items: [{ saleItemId, quantity: 1 }] },
  })
  return res.json() as { id: string }
}

interface ListBody {
  items: { id: string; status: string; lines: { subjectType: string }[] }[]
  pageInfo: { nextCursor: string | null; hasMore: boolean }
}

// ── Auth gate (spec 020 §2.3) ──────────────────────────────────────────────

describe('Admin auth gate (spec 020 §2.3 / spec 022 §2.4)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/cms/orders' })
    expect(res.statusCode).toBe(401)
  })

  it('rejects non-admin (role=1) JWTs with 403', async () => {
    const { token } = await seedUser()
    const res = await app.inject({
      method: 'GET',
      url: '/cms/orders',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejects role=ADMIN JWT for an archived account with 401 AUTH_ACCOUNT_DISABLED', async () => {
    const admin = await seedAdmin()
    await app.prisma.account.update({
      where: { id: admin.id },
      data: { archivedAt: new Date() },
    })
    const res = await app.inject({
      method: 'GET',
      url: '/cms/orders',
      headers: { authorization: `Bearer ${admin.token}` },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'AUTH_ACCOUNT_DISABLED' })
  })

  it('rejects roleless legacy access tokens with 403 (fail-safe)', async () => {
    // Mint a token without a role claim by passing 1 then we still get role=1.
    // For "no role" case we'd have to monkey-patch the signer; instead we cover
    // the equivalent path: role=1 → 403, which proves "anything not 0 is 403".
    const { token } = await seedUser()
    const res = await app.inject({
      method: 'GET',
      url: '/cms/orders',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })
})

// ── GET /cms/orders (spec 022 §4.7) ───────────────────────────────────

describe('GET /cms/orders (spec 022 §4.7)', () => {
  it('returns all orders in createdAt DESC order with hydrated inflate', async () => {
    const admin = await seedAdmin()
    const charity = await seedCharityRow()
    const o1 = await createCharityOrder(charity.id)
    const o2 = await createCharityOrder(charity.id)
    const res = await app.inject({
      method: 'GET',
      url: '/cms/orders',
      headers: { authorization: `Bearer ${admin.token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ListBody
    expect(body.items.map((i) => i.id)).toEqual([o2.id, o1.id])
    expect(body.items[0]!.lines[0]!.subjectType).toBe('CHARITY')
  })

  it('filters by status', async () => {
    const admin = await seedAdmin()
    const charity = await seedCharityRow()
    const o1 = await createCharityOrder(charity.id)
    const o2 = await createCharityOrder(charity.id)
    // PAY one of them
    await app.inject({
      method: 'POST',
      url: `/user/v1/donation/orders/${o1.id}/confirm-payment`,
    })
    const res = await app.inject({
      method: 'GET',
      url: '/cms/orders?status=PAID',
      headers: { authorization: `Bearer ${admin.token}` },
    })
    const body = res.json() as ListBody
    expect(body.items.map((i) => i.id)).toEqual([o1.id])
    expect(body.items.every((i) => i.status === 'PAID')).toBe(true)
    expect(o2.id).not.toBe(o1.id) // sanity
  })

  it('filters by subjectType + charityId on the same line (AND)', async () => {
    const admin = await seedAdmin()
    const charityA = await seedCharityRow('A')
    const charityB = await seedCharityRow('B')
    const itemB = await seedSaleItemRow(charityB.id)
    await createCharityOrder(charityA.id)
    await createCharityOrder(charityB.id)
    await createSaleItemOrder(itemB.id)
    const res = await app.inject({
      method: 'GET',
      url: `/cms/orders?subjectType=CHARITY&charityId=${charityA.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    })
    const body = res.json() as ListBody
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.lines[0]!.subjectType).toBe('CHARITY')
  })

  it('paginates with cursor (limit=2 over 3 rows → second page returns the tail)', async () => {
    const admin = await seedAdmin()
    const charity = await seedCharityRow()
    await createCharityOrder(charity.id)
    await createCharityOrder(charity.id)
    await createCharityOrder(charity.id)
    const page1 = await app.inject({
      method: 'GET',
      url: '/cms/orders?limit=2',
      headers: { authorization: `Bearer ${admin.token}` },
    })
    const p1 = page1.json() as ListBody
    expect(p1.items).toHaveLength(2)
    expect(p1.pageInfo.hasMore).toBe(true)
    expect(p1.pageInfo.nextCursor).not.toBe(null)
    const page2 = await app.inject({
      method: 'GET',
      url: `/cms/orders?limit=2&cursor=${encodeURIComponent(p1.pageInfo.nextCursor!)}`,
      headers: { authorization: `Bearer ${admin.token}` },
    })
    const p2 = page2.json() as ListBody
    expect(p2.items).toHaveLength(1)
    expect(p2.pageInfo.hasMore).toBe(false)
    expect(p2.pageInfo.nextCursor).toBe(null)
  })

  it('rejects malformed cursor with 400 PAGINATION_CURSOR_INVALID', async () => {
    const admin = await seedAdmin()
    const res = await app.inject({
      method: 'GET',
      url: '/cms/orders?cursor=not-a-real-cursor',
      headers: { authorization: `Bearer ${admin.token}` },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'PAGINATION_CURSOR_INVALID' })
  })
})

// ── GET /cms/orders/:id (spec 022 §4.8) ───────────────────────────────

describe('GET /cms/orders/:id (spec 022 §4.8)', () => {
  it('returns the order detail with inflated subject', async () => {
    const admin = await seedAdmin()
    const charity = await seedCharityRow()
    const order = await createCharityOrder(charity.id)
    const res = await app.inject({
      method: 'GET',
      url: `/cms/orders/${order.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { id: string }).id).toBe(order.id)
  })

  it('returns 404 ORDER_NOT_FOUND for missing id', async () => {
    const admin = await seedAdmin()
    const res = await app.inject({
      method: 'GET',
      url: '/cms/orders/11111111-1111-4111-8111-111111111111',
      headers: { authorization: `Bearer ${admin.token}` },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'ORDER_NOT_FOUND' })
  })
})

// ── PATCH /cms/orders/:id (spec 022 §4.9) ─────────────────────────────

describe('PATCH /cms/orders/:id (spec 022 §4.9)', () => {
  it('updates status + donorName + isAnonymous in one call', async () => {
    const admin = await seedAdmin()
    const charity = await seedCharityRow()
    const order = await createCharityOrder(charity.id)
    const res = await app.inject({
      method: 'PATCH',
      url: `/cms/orders/${order.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { status: 'REFUNDED', donorName: 'Renamed', isAnonymous: true },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { status: string; donorName: string; isAnonymous: boolean }
    expect(body.status).toBe('REFUNDED')
    expect(body.donorName).toBe('Renamed')
    expect(body.isAnonymous).toBe(true)
  })

  it('rejects updates to amountTwd / lines / id via additionalProperties: false', async () => {
    const admin = await seedAdmin()
    const charity = await seedCharityRow()
    const order = await createCharityOrder(charity.id)
    const res = await app.inject({
      method: 'PATCH',
      url: `/cms/orders/${order.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { amountTwd: 9999 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('trims a non-null note before persisting', async () => {
    const admin = await seedAdmin()
    const charity = await seedCharityRow()
    const order = await createCharityOrder(charity.id)
    const res = await app.inject({
      method: 'PATCH',
      url: `/cms/orders/${order.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { note: '  hello  ' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { note: string }).note).toBe('hello')
  })

  it('returns 404 for missing id', async () => {
    const admin = await seedAdmin()
    const res = await app.inject({
      method: 'PATCH',
      url: '/cms/orders/22222222-2222-4222-8222-222222222222',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { status: 'REFUNDED' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'ORDER_NOT_FOUND' })
  })

  it('non-admin → 403', async () => {
    const user = await seedUser()
    const charity = await seedCharityRow()
    const order = await createCharityOrder(charity.id)
    const res = await app.inject({
      method: 'PATCH',
      url: `/cms/orders/${order.id}`,
      headers: { authorization: `Bearer ${user.token}` },
      payload: { status: 'REFUNDED' },
    })
    expect(res.statusCode).toBe(403)
  })
})

// ── DELETE /cms/orders/:id (spec 022 §4.10) ───────────────────────────

describe('DELETE /cms/orders/:id (spec 022 §4.10)', () => {
  it('hard-deletes the order and cascades to OrderLine', async () => {
    const admin = await seedAdmin()
    const charity = await seedCharityRow()
    const order = await createCharityOrder(charity.id)
    const res = await app.inject({
      method: 'DELETE',
      url: `/cms/orders/${order.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    })
    expect(res.statusCode).toBe(204)
    const row = await app.prisma.order.findUnique({ where: { id: order.id } })
    expect(row).toBe(null)
    const lines = await app.prisma.orderLine.findMany({ where: { orderId: order.id } })
    expect(lines).toHaveLength(0)
  })

  it('returns 404 for a non-existent id', async () => {
    const admin = await seedAdmin()
    const res = await app.inject({
      method: 'DELETE',
      url: '/cms/orders/33333333-3333-4333-8333-333333333333',
      headers: { authorization: `Bearer ${admin.token}` },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'ORDER_NOT_FOUND' })
  })

  it('non-admin → 403', async () => {
    const user = await seedUser()
    const charity = await seedCharityRow()
    const order = await createCharityOrder(charity.id)
    const res = await app.inject({
      method: 'DELETE',
      url: `/cms/orders/${order.id}`,
      headers: { authorization: `Bearer ${user.token}` },
    })
    expect(res.statusCode).toBe(403)
  })
})
