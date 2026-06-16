// Spec 026 — Donation admin read API integration tests.
//
// Coverage matches spec 026 §9:
//   §9.1 auth gate (A1-A4)
//   §9.2 charity list (L1-L6) — lifecycle filter combinations
//   §9.3 charity detail (D1-D5) — admin sees archived / deleted by id
//   §9.4 project / sale parent cascade hint (D6-D7)
//   §9.6 locale (I1-I3)
//   §9.7 cache header (C2) + freshness (C3)
//
// Rate-limit cases (R1/R2) are intentionally not asserted here — they
// would need hundreds of injects per case. Covered structurally by reuse
// of the existing rate-limit plugin (tests/integration/rate-limit.test.ts).

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Role, signAccessToken } from '../../src/lib/auth/index.js'
import { buildApp } from '../helpers/app.js'

const REF = new Date('2026-06-14T12:00:00.000Z')
const past = (days: number): Date => new Date(REF.getTime() - days * 86_400_000)
const future = (days: number): Date => new Date(REF.getTime() + days * 86_400_000)

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

async function seedCharity(
  overrides: Partial<{
    name: string
    nameEn: string | null
    description: string
    descriptionEn: string | null
    displayOrder: number
    archivedAt: Date | null
    deletedAt: Date | null
    publishStartAt: Date | null
    publishEndAt: Date | null
  }> = {},
) {
  return app.prisma.charity.create({
    data: {
      name: overrides.name ?? 'Charity-' + Math.random().toString(36).slice(2, 8),
      nameEn: overrides.nameEn ?? undefined,
      description: overrides.description ?? 'desc',
      descriptionEn: overrides.descriptionEn ?? undefined,
      displayOrder: overrides.displayOrder ?? 0,
      archivedAt: overrides.archivedAt ?? undefined,
      deletedAt: overrides.deletedAt ?? undefined,
      publishStartAt: overrides.publishStartAt ?? undefined,
      publishEndAt: overrides.publishEndAt ?? undefined,
    },
  })
}

async function seedProject(opts: {
  charityId: string
  name?: string
  archivedAt?: Date | null
  deletedAt?: Date | null
}) {
  return app.prisma.donationProject.create({
    data: {
      charityId: opts.charityId,
      name: opts.name ?? 'Project-' + Math.random().toString(36).slice(2, 8),
      description: 'd',
      content: 'c',
      archivedAt: opts.archivedAt ?? undefined,
      deletedAt: opts.deletedAt ?? undefined,
    },
  })
}

interface ListBody<T> {
  items: T[]
  pageInfo: { nextCursor: string | null; hasMore: boolean }
}

interface CharityRow {
  id: string
  name: string
  archivedAt: string | null
  deletedAt: string | null
  publishStartAt: string | null
  publishEndAt: string | null
  displayOrder: number
}

const UNKNOWN_UUID = '11111111-1111-4111-8111-111111111111'

// ── 9.1 Auth gate ─────────────────────────────────────────────────────────

describe('Auth gate (spec 026 §9.1)', () => {
  it('A1: rejects unauthenticated GET list with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/cms/donation/charities' })
    expect(res.statusCode).toBe(401)
  })

  it('A2: rejects role=1 JWT on GET list with 403', async () => {
    const token = await userToken()
    const res = await app.inject({
      method: 'GET',
      url: '/cms/donation/charities',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('A3: rejects role=1 JWT on GET detail with 403', async () => {
    const token = await userToken()
    const c = await seedCharity()
    const res = await app.inject({
      method: 'GET',
      url: `/cms/donation/charities/${c.id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('A4: admin role=0 JWT gets 200 on list + detail', async () => {
    const token = await adminToken()
    const c = await seedCharity()
    const list = await app.inject({
      method: 'GET',
      url: '/cms/donation/charities',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(list.statusCode).toBe(200)
    const detail = await app.inject({
      method: 'GET',
      url: `/cms/donation/charities/${c.id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(detail.statusCode).toBe(200)
  })
})

// ── 9.2 List — lifecycle filter combinations ──────────────────────────────

describe('GET /cms/donation/charities — list filter (spec 026 §9.2)', () => {
  async function seedLifecycleMix() {
    await seedCharity({ name: 'live A' })
    await seedCharity({ name: 'live B' })
    await seedCharity({ name: 'live C' })
    await seedCharity({ name: 'live D' })
    await seedCharity({ name: 'live E' })
    await seedCharity({ name: 'arch1', archivedAt: past(1) })
    await seedCharity({ name: 'arch2', archivedAt: past(1) })
    await seedCharity({ name: 'del1', deletedAt: past(1) })
  }

  async function inject(query: string): Promise<ListBody<CharityRow>> {
    const token = await adminToken()
    const res = await app.inject({
      method: 'GET',
      url: `/cms/donation/charities?${query}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    return res.json() as ListBody<CharityRow>
  }

  it('L1: default (no flags) returns only non-archived non-deleted rows', async () => {
    await seedLifecycleMix()
    const body = await inject('limit=100')
    const names = body.items.map((r) => r.name).sort()
    expect(names).toEqual(['live A', 'live B', 'live C', 'live D', 'live E'])
  })

  it('L1b: default (no flags) includes scheduled / expired rows (publish window ignored)', async () => {
    // Spec 026 §2.3 — admin must see future-publish and past-publish rows.
    await seedCharity({ name: 'scheduled', publishStartAt: future(7) })
    await seedCharity({ name: 'expired', publishEndAt: past(1) })
    await seedCharity({ name: 'live now' })
    const body = await inject('limit=100')
    const names = body.items.map((r) => r.name).sort()
    expect(names).toEqual(['expired', 'live now', 'scheduled'])
  })

  it('L2: includeArchived=true adds archived rows', async () => {
    await seedLifecycleMix()
    const body = await inject('limit=100&includeArchived=true')
    expect(body.items).toHaveLength(7)
    const names = body.items.map((r) => r.name)
    expect(names).toEqual(expect.arrayContaining(['arch1', 'arch2', 'live A']))
    expect(names).not.toContain('del1')
  })

  it('L3: includeDeleted=true adds deleted rows', async () => {
    await seedLifecycleMix()
    const body = await inject('limit=100&includeDeleted=true')
    expect(body.items).toHaveLength(6)
    const names = body.items.map((r) => r.name)
    expect(names).toContain('del1')
    expect(names).not.toEqual(expect.arrayContaining(['arch1', 'arch2']))
  })

  it('L4: both flags returns the full table', async () => {
    await seedLifecycleMix()
    const body = await inject('limit=100&includeArchived=true&includeDeleted=true')
    expect(body.items).toHaveLength(8)
  })

  it('L6: every row carries admin metadata (displayOrder + publish + archivedAt + deletedAt)', async () => {
    await seedCharity({
      name: 'with metadata',
      displayOrder: 5,
      publishStartAt: future(1),
      publishEndAt: future(30),
    })
    const body = await inject('limit=100')
    const row = body.items.find((r) => r.name === 'with metadata')
    expect(row).toBeDefined()
    expect(row?.displayOrder).toBe(5)
    expect(row?.publishStartAt).toBe(future(1).toISOString())
    expect(row?.publishEndAt).toBe(future(30).toISOString())
    expect(row?.archivedAt).toBe(null)
    expect(row?.deletedAt).toBe(null)
  })
})

// ── 9.3 Charity detail — visibility ───────────────────────────────────────

describe('GET /cms/donation/charities/:id (spec 026 §9.3)', () => {
  async function injectDetail(id: string) {
    const token = await adminToken()
    return app.inject({
      method: 'GET',
      url: `/cms/donation/charities/${id}`,
      headers: { authorization: `Bearer ${token}` },
    })
  }

  it('D1: live charity returns 200 + admin shape', async () => {
    const c = await seedCharity({ name: 'happy', displayOrder: 3 })
    const res = await injectDetail(c.id)
    expect(res.statusCode).toBe(200)
    const body = res.json() as CharityRow
    expect(body.name).toBe('happy')
    expect(body.displayOrder).toBe(3)
    expect(body.archivedAt).toBe(null)
    expect(body.deletedAt).toBe(null)
  })

  it('D2: archived charity returns 200 (NOT 404) with archivedAt set', async () => {
    const c = await seedCharity({ name: 'gone', archivedAt: past(2) })
    const res = await injectDetail(c.id)
    expect(res.statusCode).toBe(200)
    const body = res.json() as CharityRow
    expect(body.archivedAt).toBe(past(2).toISOString())
  })

  it('D3: soft-deleted charity returns 200 (NOT 404) with deletedAt set', async () => {
    const c = await seedCharity({ name: 'tombstoned', deletedAt: past(3) })
    const res = await injectDetail(c.id)
    expect(res.statusCode).toBe(200)
    const body = res.json() as CharityRow
    expect(body.deletedAt).toBe(past(3).toISOString())
  })

  it('D4: unknown uuid returns 404 CHARITY_NOT_FOUND', async () => {
    const res = await injectDetail(UNKNOWN_UUID)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'CHARITY_NOT_FOUND' })
  })

  it('D5: malformed id (non-uuid) returns 400 VALIDATION_FAILED', async () => {
    const res = await injectDetail('not-a-uuid')
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})

// ── 9.4 Project / SaleItem parent cascade hints ───────────────────────────

describe('GET /cms/donation/donation-projects/:id parent cascade hint (spec 026 §9.4)', () => {
  it('D6: archived charity + live project returns parentCharityArchivedAt non-null', async () => {
    const charity = await seedCharity({ name: 'archived parent', archivedAt: past(1) })
    const project = await seedProject({ charityId: charity.id, name: 'still active' })

    const token = await adminToken()
    const res = await app.inject({
      method: 'GET',
      url: `/cms/donation/donation-projects/${project.id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as CharityRow & {
      parentCharityArchivedAt: string | null
      parentCharityDeletedAt: string | null
    }
    expect(body.parentCharityArchivedAt).toBe(past(1).toISOString())
    expect(body.parentCharityDeletedAt).toBe(null)
    // Own state still clean.
    expect(body.archivedAt).toBe(null)
    expect(body.deletedAt).toBe(null)
  })

  it('D7: live charity + deleted project returns project.deletedAt non-null, parentCharity*At null', async () => {
    const charity = await seedCharity({ name: 'live parent' })
    const project = await seedProject({
      charityId: charity.id,
      name: 'tombstoned proj',
      deletedAt: past(1),
    })

    const token = await adminToken()
    const res = await app.inject({
      method: 'GET',
      url: `/cms/donation/donation-projects/${project.id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as CharityRow & {
      parentCharityArchivedAt: string | null
      parentCharityDeletedAt: string | null
    }
    expect(body.deletedAt).toBe(past(1).toISOString())
    expect(body.parentCharityArchivedAt).toBe(null)
    expect(body.parentCharityDeletedAt).toBe(null)
  })

  it('returns 404 DONATION_PROJECT_NOT_FOUND for unknown id', async () => {
    const token = await adminToken()
    const res = await app.inject({
      method: 'GET',
      url: `/cms/donation/donation-projects/${UNKNOWN_UUID}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'DONATION_PROJECT_NOT_FOUND' })
  })
})

describe('GET /cms/donation/donation-projects — list shape (spec 026 §5.2.1)', () => {
  it('returns nested `charity: {id, name, logoUrl}` (NOT flat charityId/charityName)', async () => {
    const charity = await seedCharity({ name: 'parent co', nameEn: 'Parent Co' })
    await app.prisma.charity.update({
      where: { id: charity.id },
      data: { logoKey: 'logo/parent.png' },
    })
    await seedProject({ charityId: charity.id, name: 'child proj' })

    const token = await adminToken()
    const res = await app.inject({
      method: 'GET',
      url: '/cms/donation/donation-projects?limit=100',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ListBody<{
      name: string
      charity: { id: string; name: string; logoUrl: string | null }
      charityId?: unknown
      charityName?: unknown
      createdAt?: unknown
      updatedAt?: unknown
    }>
    const row = body.items[0]
    expect(row?.name).toBe('child proj')
    expect(row?.charity).toEqual({
      id: charity.id,
      name: 'parent co',
      logoUrl: expect.stringContaining('logo/parent.png'),
    })
    // Strict spec alignment — these public-list fields MUST NOT appear.
    expect(row?.charityId).toBeUndefined()
    expect(row?.charityName).toBeUndefined()
    expect(row?.createdAt).toBeUndefined()
    expect(row?.updatedAt).toBeUndefined()
  })
})

describe('GET /cms/donation/sale-items/:id (spec 026 §5.3.2)', () => {
  it('returns 404 SALE_ITEM_NOT_FOUND for unknown id', async () => {
    const token = await adminToken()
    const res = await app.inject({
      method: 'GET',
      url: `/cms/donation/sale-items/${UNKNOWN_UUID}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'SALE_ITEM_NOT_FOUND' })
  })

  it('list returns nested charity + priceTwd; omits charityId/charityName + createdAt/updatedAt', async () => {
    const charity = await seedCharity({ name: 'parent co' })
    await app.prisma.saleItem.create({
      data: {
        charityId: charity.id,
        name: 'item-1',
        description: 'd',
        content: 'c',
        priceTwd: 100,
      },
    })
    const token = await adminToken()
    const res = await app.inject({
      method: 'GET',
      url: '/cms/donation/sale-items?limit=100',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ListBody<{
      name: string
      priceTwd: number
      charity: { id: string; name: string; logoUrl: string | null }
      charityId?: unknown
      charityName?: unknown
      createdAt?: unknown
      updatedAt?: unknown
    }>
    const row = body.items[0]
    expect(row?.name).toBe('item-1')
    expect(row?.priceTwd).toBe(100)
    expect(row?.charity).toEqual({ id: charity.id, name: 'parent co', logoUrl: null })
    expect(row?.charityId).toBeUndefined()
    expect(row?.charityName).toBeUndefined()
    expect(row?.createdAt).toBeUndefined()
    expect(row?.updatedAt).toBeUndefined()
  })
})

describe('GET /cms/donation/charities — list shape (spec 026 §5.1.1)', () => {
  it('omits createdAt/updatedAt (not in spec inline shape)', async () => {
    await seedCharity({ name: 'shape check' })
    const token = await adminToken()
    const res = await app.inject({
      method: 'GET',
      url: '/cms/donation/charities?limit=100',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ListBody<{
      name: string
      createdAt?: unknown
      updatedAt?: unknown
    }>
    const row = body.items.find((r) => r.name === 'shape check')
    expect(row?.createdAt).toBeUndefined()
    expect(row?.updatedAt).toBeUndefined()
  })
})

// ── 9.6 Locale ────────────────────────────────────────────────────────────

describe('Locale handling (spec 026 §9.6)', () => {
  it('I1: zh-TW returns Chinese name', async () => {
    const c = await seedCharity({ name: '中文', nameEn: 'English' })
    const token = await adminToken()
    const res = await app.inject({
      method: 'GET',
      url: `/cms/donation/charities/${c.id}`,
      headers: { authorization: `Bearer ${token}`, 'accept-language': 'zh-TW' },
    })
    expect((res.json() as CharityRow).name).toBe('中文')
  })

  it('I2: en returns English name', async () => {
    const c = await seedCharity({ name: '中文', nameEn: 'English' })
    const token = await adminToken()
    const res = await app.inject({
      method: 'GET',
      url: `/cms/donation/charities/${c.id}`,
      headers: { authorization: `Bearer ${token}`, 'accept-language': 'en' },
    })
    expect((res.json() as CharityRow).name).toBe('English')
  })

  it('I3: missing header defaults to zh-TW', async () => {
    const c = await seedCharity({ name: '中文', nameEn: 'English' })
    const token = await adminToken()
    const res = await app.inject({
      method: 'GET',
      url: `/cms/donation/charities/${c.id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect((res.json() as CharityRow).name).toBe('中文')
  })
})

// ── 9.7 Cache headers ─────────────────────────────────────────────────────

describe('Cache headers (spec 026 §9.7)', () => {
  it('C2: response header is `Cache-Control: no-store, private`', async () => {
    const c = await seedCharity()
    const token = await adminToken()
    const res = await app.inject({
      method: 'GET',
      url: `/cms/donation/charities/${c.id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store, private')
  })

  it('C3: PATCH then GET returns the new value (no stale cache window)', async () => {
    const c = await seedCharity({ name: 'before' })
    const token = await adminToken()
    await app.inject({
      method: 'PATCH',
      url: `/cms/donation/charities/${c.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'after' },
    })
    const res = await app.inject({
      method: 'GET',
      url: `/cms/donation/charities/${c.id}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect((res.json() as CharityRow).name).toBe('after')
  })
})
