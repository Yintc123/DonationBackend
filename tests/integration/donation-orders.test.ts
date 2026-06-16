// Spec 022 §10 — integration coverage for the three Phase 2 create endpoints.
//
// Covers every line of the §10 test table that corresponds to Phase 2
// scope (creates only; confirm-payment / cancel / GET / admin land in
// Phase 3). The TypeBox / service / domain / DB layers are exercised
// end-to-end against the real testcontainer Postgres — there is no
// mocking of Prisma per the backend CLAUDE.md mocking policy.
//
// Time-sensitive cases use `vi.useFakeTimers` + `vi.setSystemTime` so
// `systemClock` (decorated on app.clock) returns the chosen Date — the
// spec 021 §7.7 / spec 022 §4.0 contract.

import type { Charity, DonationProject, SaleItem } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../helpers/app.js'

let app: FastifyInstance

beforeEach(async () => {
  app = await buildApp()
})

afterEach(async () => {
  await app.close()
  vi.useRealTimers()
})

// ── Fixtures ───────────────────────────────────────────────────────────────

async function seedCharity(over: Partial<Charity> = {}): Promise<Charity> {
  return app.prisma.charity.create({
    data: {
      name: over.name ?? 'Charity-' + Math.random().toString(36).slice(2, 8),
      description: over.description ?? 'desc',
      logoKey: over.logoKey ?? null,
      publishStartAt: over.publishStartAt ?? null,
      publishEndAt: over.publishEndAt ?? null,
      archivedAt: over.archivedAt ?? null,
      deletedAt: over.deletedAt ?? null,
    },
  })
}

async function seedProject(
  charityId: string,
  over: Partial<DonationProject> = {},
): Promise<DonationProject> {
  return app.prisma.donationProject.create({
    data: {
      charityId,
      name: over.name ?? 'Project-' + Math.random().toString(36).slice(2, 8),
      description: 'd',
      content: 'c',
      publishStartAt: over.publishStartAt ?? null,
      publishEndAt: over.publishEndAt ?? null,
    },
  })
}

async function seedSaleItem(
  charityId: string,
  over: Partial<SaleItem> = {},
): Promise<SaleItem> {
  return app.prisma.saleItem.create({
    data: {
      charityId,
      name: over.name ?? 'Item-' + Math.random().toString(36).slice(2, 8),
      description: 'd',
      content: 'c',
      priceTwd: over.priceTwd ?? 449,
      publishStartAt: over.publishStartAt ?? null,
      publishEndAt: over.publishEndAt ?? null,
    },
  })
}

interface OrderJson {
  id: string
  status: string
  donorName: string
  isAnonymous: boolean
  receiptOption: string | null
  note: string | null
  amountTwd: number
  nextChargeAt: string | null
  paidAt: string | null
  cancelledAt: string | null
  createdAt: string
  updatedAt: string
  lines: {
    id: string
    subjectType: 'CHARITY' | 'DONATION_PROJECT' | 'SALE_ITEM'
    charityId: string | null
    donationProjectId: string | null
    saleItemId: string | null
    quantity: number
    unitPriceTwd: number
    subtotalTwd: number
    donationFrequency: 'ONE_TIME' | 'RECURRING' | null
    billingDay: 'DAY_6' | 'DAY_16' | 'DAY_26' | null
    createdAt: string
    charity: { id: string; name: string; logoUrl: string | null } | null
    donationProject: { id: string; name: string; charity: { id: string; name: string; logoUrl: string | null } } | null
    saleItem: { id: string; name: string; priceTwd: number; charity: { id: string; name: string; logoUrl: string | null } } | null
  }[]
}

// ── POST /user/v1/donation/orders/charity-donation (§4.1) ───────────────────────

describe('POST /user/v1/donation/orders/charity-donation (spec 022 §4.1)', () => {
  it('creates a ONE_TIME donation: 201 + line subjectType=CHARITY, frequency=ONE_TIME, billingDay=null', async () => {
    const charity = await seedCharity({ name: 'Helpful Org' })
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/charity-donation',
      payload: {
        donorName: '張三',
        receiptOption: 'NONE',
        charityId: charity.id,
        donationFrequency: 'ONE_TIME',
        amountTwd: 500,
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.headers.location).toMatch(/^\/user\/v1\/donation\/orders\//)
    const body = res.json() as OrderJson
    expect(body.status).toBe('PENDING')
    expect(body.donorName).toBe('張三')
    expect(body.isAnonymous).toBe(false)
    expect(body.amountTwd).toBe(500)
    expect(body.nextChargeAt).toBe(null)
    expect(body.lines).toHaveLength(1)
    const [line] = body.lines
    expect(line!.subjectType).toBe('CHARITY')
    expect(line!.charityId).toBe(charity.id)
    expect(line!.donationFrequency).toBe('ONE_TIME')
    expect(line!.billingDay).toBe(null)
    expect(line!.subtotalTwd).toBe(500)
    expect(line!.unitPriceTwd).toBe(500)
    expect(line!.quantity).toBe(1)
    expect(line!.charity).toEqual({ id: charity.id, name: 'Helpful Org', logoUrl: null })
    expect(line!.donationProject).toBe(null)
    expect(line!.saleItem).toBe(null)
  })

  it('creates a RECURRING donation: line.billingDay set + Order.nextChargeAt computed', async () => {
    // toFake: ['Date'] only — default useFakeTimers also fakes setImmediate /
    // queueMicrotask, which deadlocks Fastify's async route registration.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-15T08:00:00.000Z'))
    const charity = await seedCharity()
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/charity-donation',
      payload: {
        donorName: '李四',
        receiptOption: 'INDIVIDUAL',
        charityId: charity.id,
        donationFrequency: 'RECURRING',
        billingDay: 'DAY_16',
        amountTwd: 1500,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as OrderJson
    expect(body.nextChargeAt).toBe('2026-06-16T00:00:00.000Z')
    expect(body.lines[0]!.billingDay).toBe('DAY_16')
    expect(body.lines[0]!.donationFrequency).toBe('RECURRING')
  })

  it('returns 400 INVALID_BILLING_DAY when RECURRING omits billingDay', async () => {
    const charity = await seedCharity()
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/charity-donation',
      payload: {
        donorName: '張三',
        receiptOption: 'NONE',
        charityId: charity.id,
        donationFrequency: 'RECURRING',
        amountTwd: 500,
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_BILLING_DAY' })
  })

  it('returns 400 INVALID_BILLING_DAY when ONE_TIME sets billingDay', async () => {
    const charity = await seedCharity()
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/charity-donation',
      payload: {
        donorName: '張三',
        receiptOption: 'NONE',
        charityId: charity.id,
        donationFrequency: 'ONE_TIME',
        billingDay: 'DAY_16',
        amountTwd: 500,
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'INVALID_BILLING_DAY' })
  })

  it('returns 404 CHARITY_NOT_FOUND for a non-live charity (publishEndAt past)', async () => {
    const charity = await seedCharity({ publishEndAt: new Date('2020-01-01T00:00:00Z') })
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/charity-donation',
      payload: {
        donorName: '張三',
        receiptOption: 'NONE',
        charityId: charity.id,
        donationFrequency: 'ONE_TIME',
        amountTwd: 500,
      },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'CHARITY_NOT_FOUND' })
  })

  it('returns 400 VALIDATION_FAILED when charity-donation body misses receiptOption (TypeBox required)', async () => {
    const charity = await seedCharity()
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/charity-donation',
      payload: {
        donorName: '張三',
        charityId: charity.id,
        donationFrequency: 'ONE_TIME',
        amountTwd: 500,
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('returns 400 VALIDATION_FAILED on unknown property in body (additionalProperties: false)', async () => {
    const charity = await seedCharity()
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/charity-donation',
      payload: {
        donorName: '張三',
        receiptOption: 'NONE',
        charityId: charity.id,
        donationFrequency: 'ONE_TIME',
        amountTwd: 500,
        foo: 'bar',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('respects isAnonymous=true and persists it to DB', async () => {
    const charity = await seedCharity()
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/charity-donation',
      payload: {
        donorName: '張三',
        isAnonymous: true,
        receiptOption: 'NONE',
        charityId: charity.id,
        donationFrequency: 'ONE_TIME',
        amountTwd: 500,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as OrderJson
    expect(body.isAnonymous).toBe(true)
    const row = await app.prisma.order.findUnique({ where: { id: body.id } })
    expect(row?.isAnonymous).toBe(true)
  })

  it('defaults isAnonymous to false when omitted', async () => {
    const charity = await seedCharity()
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/charity-donation',
      payload: {
        donorName: '張三',
        receiptOption: 'NONE',
        charityId: charity.id,
        donationFrequency: 'ONE_TIME',
        amountTwd: 500,
      },
    })
    const body = res.json() as OrderJson
    expect(body.isAnonymous).toBe(false)
    const row = await app.prisma.order.findUnique({ where: { id: body.id } })
    expect(row?.isAnonymous).toBe(false)
  })

  it('trims whitespace-only note to null in DB and response', async () => {
    const charity = await seedCharity()
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/charity-donation',
      payload: {
        donorName: '張三',
        receiptOption: 'NONE',
        note: '   ',
        charityId: charity.id,
        donationFrequency: 'ONE_TIME',
        amountTwd: 500,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as OrderJson
    expect(body.note).toBe(null)
  })

  it('trims surrounding whitespace from note', async () => {
    const charity = await seedCharity()
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/charity-donation',
      payload: {
        donorName: '張三',
        receiptOption: 'NONE',
        note: '  please dedicate  ',
        charityId: charity.id,
        donationFrequency: 'ONE_TIME',
        amountTwd: 500,
      },
    })
    const body = res.json() as OrderJson
    expect(body.note).toBe('please dedicate')
  })

  it('inflates logoUrl from logoKey via the s3 plugin (objectUrl)', async () => {
    const charity = await seedCharity({ logoKey: 'charities/abc/logo.png' })
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/charity-donation',
      payload: {
        donorName: '張三',
        receiptOption: 'NONE',
        charityId: charity.id,
        donationFrequency: 'ONE_TIME',
        amountTwd: 500,
      },
    })
    const body = res.json() as OrderJson
    expect(body.lines[0]!.charity!.logoUrl).toMatch(/charities\/abc\/logo\.png$/)
  })

  it('treats same-day billingDay as already-past (next month)', async () => {
    // toFake: ['Date'] only — default useFakeTimers also fakes setImmediate /
    // queueMicrotask, which deadlocks Fastify's async route registration.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-16T08:00:00.000Z'))
    const charity = await seedCharity()
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/charity-donation',
      payload: {
        donorName: '張三',
        receiptOption: 'INDIVIDUAL',
        charityId: charity.id,
        donationFrequency: 'RECURRING',
        billingDay: 'DAY_16',
        amountTwd: 500,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as OrderJson
    expect(body.nextChargeAt).toBe('2026-07-16T00:00:00.000Z')
  })
})

// ── POST /user/v1/donation/orders/project-donation (§4.2) ───────────────────────

describe('POST /user/v1/donation/orders/project-donation (spec 022 §4.2)', () => {
  it('creates with inflated donationProject + parent charity', async () => {
    const charity = await seedCharity({ name: 'Parent C' })
    const project = await seedProject(charity.id, { name: 'Cute project' })
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/project-donation',
      payload: {
        donorName: '王五',
        receiptOption: 'CORPORATE',
        donationProjectId: project.id,
        donationFrequency: 'ONE_TIME',
        amountTwd: 2000,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as OrderJson
    const line = body.lines[0]!
    expect(line.subjectType).toBe('DONATION_PROJECT')
    expect(line.donationProject?.id).toBe(project.id)
    expect(line.donationProject?.name).toBe('Cute project')
    expect(line.donationProject?.charity).toEqual({
      id: charity.id,
      name: 'Parent C',
      logoUrl: null,
    })
    expect(line.charity).toBe(null)
    expect(line.saleItem).toBe(null)
  })

  it('returns 404 when the parent charity is expired (cascading visibility)', async () => {
    const charity = await seedCharity({ publishEndAt: new Date('2020-01-01T00:00:00Z') })
    const project = await seedProject(charity.id)
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/project-donation',
      payload: {
        donorName: 'X',
        receiptOption: 'NONE',
        donationProjectId: project.id,
        donationFrequency: 'ONE_TIME',
        amountTwd: 500,
      },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'DONATION_PROJECT_NOT_FOUND' })
  })

  it('respects isAnonymous=true on project-donation (spec 021 v0.8 — three subjects share the flag)', async () => {
    const charity = await seedCharity()
    const project = await seedProject(charity.id)
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/project-donation',
      payload: {
        donorName: '匿名專案捐款者',
        isAnonymous: true,
        receiptOption: 'NONE',
        donationProjectId: project.id,
        donationFrequency: 'ONE_TIME',
        amountTwd: 500,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as OrderJson
    expect(body.isAnonymous).toBe(true)
    const row = await app.prisma.order.findUnique({ where: { id: body.id } })
    expect(row?.isAnonymous).toBe(true)
  })
})

// ── POST /user/v1/donation/orders/sale-item-purchase (§4.3) ─────────────────────

describe('POST /user/v1/donation/orders/sale-item-purchase (spec 022 §4.3)', () => {
  it('creates with snapshot priceTwd and computes subtotal = qty × price', async () => {
    const charity = await seedCharity({ name: 'Seller Org' })
    const item = await seedSaleItem(charity.id, { name: 'Noodle', priceTwd: 449 })
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/sale-item-purchase',
      payload: {
        donorName: 'Buyer',
        items: [{ saleItemId: item.id, quantity: 2 }],
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as OrderJson
    expect(body.amountTwd).toBe(898)
    expect(body.receiptOption).toBe(null)
    expect(body.nextChargeAt).toBe(null)
    const line = body.lines[0]!
    expect(line.subjectType).toBe('SALE_ITEM')
    expect(line.quantity).toBe(2)
    expect(line.unitPriceTwd).toBe(449)
    expect(line.subtotalTwd).toBe(898)
    expect(line.saleItem?.name).toBe('Noodle')
    expect(line.saleItem?.priceTwd).toBe(449)
    expect(line.saleItem?.charity).toEqual({ id: charity.id, name: 'Seller Org', logoUrl: null })
  })

  it('returns 400 VALIDATION_FAILED for empty items array (minItems: 1)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/sale-item-purchase',
      payload: { donorName: 'Buyer', items: [] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('returns 400 VALIDATION_FAILED for 2 items (maxItems: 1, phase-1 cart cap)', async () => {
    const charity = await seedCharity()
    const a = await seedSaleItem(charity.id)
    const b = await seedSaleItem(charity.id)
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/sale-item-purchase',
      payload: {
        donorName: 'Buyer',
        items: [
          { saleItemId: a.id, quantity: 1 },
          { saleItemId: b.id, quantity: 1 },
        ],
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('returns 404 when saleItem does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/sale-item-purchase',
      payload: {
        donorName: 'Buyer',
        items: [{ saleItemId: '11111111-1111-4111-8111-111111111111', quantity: 1 }],
      },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'SALE_ITEM_NOT_FOUND' })
  })

  it('returns 400 VALIDATION_FAILED when SaleItem body smuggles a receiptOption (additionalProperties: false)', async () => {
    const charity = await seedCharity()
    const item = await seedSaleItem(charity.id)
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/sale-item-purchase',
      payload: {
        donorName: 'Buyer',
        receiptOption: 'INDIVIDUAL',
        items: [{ saleItemId: item.id, quantity: 1 }],
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('snapshots SaleItem.priceTwd at create-time (changing the entity after creation does not retroactively re-price)', async () => {
    const charity = await seedCharity()
    const item = await seedSaleItem(charity.id, { priceTwd: 100 })
    const create = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/sale-item-purchase',
      payload: { donorName: 'B', items: [{ saleItemId: item.id, quantity: 3 }] },
    })
    const body = create.json() as OrderJson
    expect(body.amountTwd).toBe(300)
    // bump the price afterwards
    await app.prisma.saleItem.update({ where: { id: item.id }, data: { priceTwd: 999 } })
    const row = await app.prisma.order.findUnique({ where: { id: body.id }, include: { lines: true } })
    expect(row?.lines[0]?.unitPriceTwd).toBe(100)
    expect(row?.amountTwd).toBe(300)
  })

  it('respects isAnonymous=true on sale-item-purchase (spec 021 v0.8)', async () => {
    const charity = await seedCharity()
    const item = await seedSaleItem(charity.id)
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/sale-item-purchase',
      payload: {
        donorName: '匿名買家',
        isAnonymous: true,
        items: [{ saleItemId: item.id, quantity: 1 }],
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as OrderJson
    expect(body.isAnonymous).toBe(true)
    const row = await app.prisma.order.findUnique({ where: { id: body.id } })
    expect(row?.isAnonymous).toBe(true)
  })
})

// ── helpers for Phase 3 lifecycle tests ────────────────────────────────────

async function createPendingCharityOrder(): Promise<OrderJson> {
  const charity = await seedCharity()
  const res = await app.inject({
    method: 'POST',
    url: '/user/v1/donation/orders/charity-donation',
    payload: {
      donorName: 'X',
      receiptOption: 'NONE',
      charityId: charity.id,
      donationFrequency: 'ONE_TIME',
      amountTwd: 500,
    },
  })
  return res.json() as OrderJson
}

// ── GET /user/v1/donation/orders/:id (§4.6) ─────────────────────────────────────

describe('GET /user/v1/donation/orders/:id (spec 022 §4.6)', () => {
  it('returns the order with the same shape as the create response', async () => {
    const created = await createPendingCharityOrder()
    const res = await app.inject({ method: 'GET', url: `/user/v1/donation/orders/${created.id}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as OrderJson
    expect(body.id).toBe(created.id)
    expect(body.status).toBe('PENDING')
    expect(body.lines).toHaveLength(1)
    expect(body.lines[0]!.charity).not.toBe(null)
  })

  it('returns 404 ORDER_NOT_FOUND for an unknown id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/orders/11111111-1111-4111-8111-111111111111',
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'ORDER_NOT_FOUND' })
  })

  it('returns 400 VALIDATION_FAILED for a malformed (non-UUID) id', async () => {
    const res = await app.inject({ method: 'GET', url: '/user/v1/donation/orders/not-a-uuid' })
    expect(res.statusCode).toBe(400)
  })

  it('echoes donorName / isAnonymous / note untouched (no server-side masking, spec 022 §4.6)', async () => {
    const charity = await seedCharity()
    const create = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/charity-donation',
      payload: {
        donorName: '匿名先生',
        isAnonymous: true,
        note: 'please',
        receiptOption: 'NONE',
        charityId: charity.id,
        donationFrequency: 'ONE_TIME',
        amountTwd: 500,
      },
    })
    const created = create.json() as OrderJson
    const res = await app.inject({ method: 'GET', url: `/user/v1/donation/orders/${created.id}` })
    const body = res.json() as OrderJson
    expect(body.donorName).toBe('匿名先生')
    expect(body.isAnonymous).toBe(true)
    expect(body.note).toBe('please')
  })
})

// ── POST /:id/confirm-payment (§4.4) ───────────────────────────────────────

describe('POST /user/v1/donation/orders/:id/confirm-payment (spec 022 §4.4)', () => {
  it('transitions PENDING → PAID and stamps paidAt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-01T10:00:00.000Z'))
    const created = await createPendingCharityOrder()

    const res = await app.inject({
      method: 'POST',
      url: `/user/v1/donation/orders/${created.id}/confirm-payment`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as OrderJson
    expect(body.status).toBe('PAID')
    expect(body.paidAt).toBe('2026-07-01T10:00:00.000Z')
    expect(body.cancelledAt).toBe(null)
  })

  it('is idempotent when status is already PAID (200 no-op, paidAt unchanged)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-01T10:00:00.000Z'))
    const created = await createPendingCharityOrder()
    const first = await app.inject({
      method: 'POST',
      url: `/user/v1/donation/orders/${created.id}/confirm-payment`,
    })
    const firstBody = first.json() as OrderJson
    expect(firstBody.status).toBe('PAID')

    // move time forward — second confirm should NOT re-stamp paidAt
    vi.setSystemTime(new Date('2026-07-02T10:00:00.000Z'))
    const second = await app.inject({
      method: 'POST',
      url: `/user/v1/donation/orders/${created.id}/confirm-payment`,
    })
    expect(second.statusCode).toBe(200)
    const secondBody = second.json() as OrderJson
    expect(secondBody.status).toBe('PAID')
    expect(secondBody.paidAt).toBe('2026-07-01T10:00:00.000Z')
  })

  it('returns 409 ORDER_STATUS_INVALID when starting from CANCELLED', async () => {
    const created = await createPendingCharityOrder()
    await app.inject({
      method: 'POST',
      url: `/user/v1/donation/orders/${created.id}/cancel`,
    })
    const res = await app.inject({
      method: 'POST',
      url: `/user/v1/donation/orders/${created.id}/confirm-payment`,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'ORDER_STATUS_INVALID' })
  })

  it('returns 404 ORDER_NOT_FOUND for a missing order', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/22222222-2222-4222-8222-222222222222/confirm-payment',
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'ORDER_NOT_FOUND' })
  })

  it('atomic claim: concurrent confirm-payment yields exactly one transition (spec 022 §4.4)', async () => {
    // spec 022 §4.4 / lifecycle-services.ts updateMany conditional update —
    // load-bearing claim that two simultaneous confirms cannot both win.
    // Test by issuing N=5 parallel confirms against the same PENDING order;
    // expect 5×200 (idempotent), a single paidAt timestamp in DB, and only
    // one row state transition (the others land on the "already PAID" idempotent
    // branch).
    const created = await createPendingCharityOrder()
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: 'POST',
          url: `/user/v1/donation/orders/${created.id}/confirm-payment`,
        }),
      ),
    )
    expect(responses.every((r) => r.statusCode === 200)).toBe(true)
    expect(responses.every((r) => (r.json() as OrderJson).status === 'PAID')).toBe(true)
    // Every response should show the SAME paidAt — the winner's timestamp.
    const paidAts = new Set(responses.map((r) => (r.json() as OrderJson).paidAt))
    expect(paidAts.size).toBe(1)
    // DB row authoritative check.
    const row = await app.prisma.order.findUnique({ where: { id: created.id } })
    expect(row?.status).toBe('PAID')
    expect(row?.paidAt).not.toBe(null)
  })
})

// ── POST /:id/cancel (§4.5) ────────────────────────────────────────────────

describe('POST /user/v1/donation/orders/:id/cancel (spec 022 §4.5)', () => {
  it('transitions PENDING → CANCELLED and stamps cancelledAt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-03T08:00:00.000Z'))
    const created = await createPendingCharityOrder()
    const res = await app.inject({
      method: 'POST',
      url: `/user/v1/donation/orders/${created.id}/cancel`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as OrderJson
    expect(body.status).toBe('CANCELLED')
    expect(body.cancelledAt).toBe('2026-07-03T08:00:00.000Z')
    expect(body.paidAt).toBe(null)
  })

  it('is idempotent when already CANCELLED', async () => {
    const created = await createPendingCharityOrder()
    await app.inject({ method: 'POST', url: `/user/v1/donation/orders/${created.id}/cancel` })
    const res = await app.inject({
      method: 'POST',
      url: `/user/v1/donation/orders/${created.id}/cancel`,
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as OrderJson).status).toBe('CANCELLED')
  })

  it('returns 409 ORDER_STATUS_INVALID when starting from PAID (user cannot cancel a paid order)', async () => {
    const created = await createPendingCharityOrder()
    await app.inject({
      method: 'POST',
      url: `/user/v1/donation/orders/${created.id}/confirm-payment`,
    })
    const res = await app.inject({
      method: 'POST',
      url: `/user/v1/donation/orders/${created.id}/cancel`,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'ORDER_STATUS_INVALID' })
  })

  it('returns 404 ORDER_NOT_FOUND for a missing order', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/user/v1/donation/orders/33333333-3333-4333-8333-333333333333/cancel',
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'ORDER_NOT_FOUND' })
  })
})
