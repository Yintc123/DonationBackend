// Spec 016 / spec 017 — donation public read API integration tests.
//
// Tests boot a real Fastify app against the testcontainer Postgres + Redis +
// LocalStack S3. We seed minimal fixtures per test (per-test-setup TRUNCATEs).

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { encodeCursor } from '../../src/lib/cursor/index.js'
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

async function seedCategory(opts: { key: string; displayName?: string; displayOrder?: number }) {
  return app.prisma.category.create({
    data: {
      key: opts.key,
      displayName: opts.displayName ?? `display:${opts.key}`,
      displayNameEn: `Display ${opts.key}`,
      displayOrder: opts.displayOrder ?? 0,
    },
  })
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
    logoKey: string | null
    categoryIds: string[]
  }> = {},
) {
  const c = await app.prisma.charity.create({
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
      logoKey: overrides.logoKey ?? undefined,
    },
  })
  for (const categoryId of overrides.categoryIds ?? []) {
    await app.prisma.charityOnCategory.create({ data: { charityId: c.id, categoryId } })
  }
  return c
}

async function seedProject(opts: {
  charityId: string
  name?: string
  archivedAt?: Date | null
  deletedAt?: Date | null
  publishStartAt?: Date | null
  publishEndAt?: Date | null
}) {
  return app.prisma.donationProject.create({
    data: {
      charityId: opts.charityId,
      name: opts.name ?? 'Project-' + Math.random().toString(36).slice(2, 8),
      description: 'd',
      content: 'c',
      archivedAt: opts.archivedAt ?? undefined,
      deletedAt: opts.deletedAt ?? undefined,
      publishStartAt: opts.publishStartAt ?? undefined,
      publishEndAt: opts.publishEndAt ?? undefined,
    },
  })
}

interface JsonBody {
  items: Record<string, unknown>[]
  pageInfo: { nextCursor: string | null; hasMore: boolean }
}

describe('GET /user/v1/donation/charities (spec 016 §4)', () => {
  it('returns lifecycle-filtered charities with paginated envelope', async () => {
    await seedCharity({ name: 'live A' })
    await seedCharity({ name: 'live B' })
    await seedCharity({ name: 'archived', archivedAt: past(1) })
    await seedCharity({ name: 'deleted', deletedAt: past(1) })
    await seedCharity({ name: 'scheduled', publishStartAt: future(1) })
    await seedCharity({ name: 'expired', publishEndAt: past(1) })

    const res = await app.inject({ method: 'GET', url: '/user/v1/donation/charities' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as JsonBody
    const names = body.items.map((i) => i.name)
    expect(names).toEqual(expect.arrayContaining(['live A', 'live B']))
    expect(names).not.toEqual(
      expect.arrayContaining(['archived', 'deleted', 'scheduled', 'expired']),
    )
    expect(body.pageInfo).toEqual({ nextCursor: null, hasMore: false })
  })

  it('sorts by displayOrder ASC, createdAt DESC, id DESC (v0.11)', async () => {
    const pinned = await seedCharity({ name: 'pinned', displayOrder: -1 })
    const normal = await seedCharity({ name: 'normal' })
    const res = await app.inject({ method: 'GET', url: '/user/v1/donation/charities' })
    const body = res.json() as JsonBody
    const ids = body.items.map((i) => i.id as string)
    expect(ids.indexOf(pinned.id)).toBeLessThan(ids.indexOf(normal.id))
  })

  it('q ILIKE search filters by name OR description in zh-TW locale', async () => {
    await seedCharity({ name: '流浪動物保護協會' })
    await seedCharity({ name: '無關項目' })
    const res = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/charities',
      query: { q: '流浪動物' },
    })
    const body = res.json() as JsonBody
    expect(body.items.map((i) => i.name)).toEqual(['流浪動物保護協會'])
  })

  it('q is NFC-normalised before search (spec 016 §4.2 v0.13 — B2)', async () => {
    // Store the row using the precomposed (NFC) form …
    await seedCharity({
      name: '原始中文',
      nameEn: 'café society',
      description: '中文描述',
      descriptionEn: 'a café society description',
    })
    // … and search with a client that sent the decomposed (NFD) form.
    // Without normalisation, ILIKE wouldn't match.
    const decomposedQ = 'café' // c + a + f + e + COMBINING ACUTE ACCENT
    const res = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/charities',
      query: { q: decomposedQ },
      headers: { 'accept-language': 'en' },
    })
    const body = res.json() as JsonBody
    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.name).toBe('café society')
  })

  it('q with only whitespace is treated as no filter (spec 016 §5.2)', async () => {
    await seedCharity({ name: 'visible A' })
    await seedCharity({ name: 'visible B' })
    const res = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/charities',
      query: { q: '   ' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as JsonBody
    expect(body.items.map((i) => i.name).sort()).toEqual(['visible A', 'visible B'])
  })

  it('Accept-Language: en uses English name+description for both response and search', async () => {
    await seedCharity({
      name: '原始中文',
      nameEn: 'Stray Animal Shelter',
      description: '中文描述',
      descriptionEn: 'English description about strays',
    })
    const res = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/charities',
      query: { q: 'stray' },
      headers: { 'accept-language': 'en' },
    })
    const body = res.json() as JsonBody
    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.name).toBe('Stray Animal Shelter')
    expect(res.headers['content-language']).toBe('en')
    expect(res.headers['vary']).toBe('Accept-Language, Origin')
  })

  it('falls back to zh name when row has no nameEn but locale=en', async () => {
    await seedCharity({ name: '只有中文', nameEn: null })
    const res = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/charities',
      headers: { 'accept-language': 'en' },
    })
    const body = res.json() as JsonBody
    expect(body.items[0]?.name).toBe('只有中文')
  })

  it('?category=animal_protection filters by Charity M:N attachment', async () => {
    const cat = await seedCategory({ key: 'animal_protection' })
    await seedCharity({ name: 'animal charity', categoryIds: [cat.id] })
    await seedCharity({ name: 'other charity' })
    const res = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/charities',
      query: { category: 'animal_protection' },
    })
    const body = res.json() as JsonBody
    expect(body.items.map((i) => i.name)).toEqual(['animal charity'])
  })

  it('rejects unknown category with the dedicated CATEGORY_UNKNOWN code (spec 016 §5.1)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/charities',
      query: { category: 'animals' },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as {
      code: string
      details: { category: string; allowed: string[] }
    }
    expect(body.code).toBe('CATEGORY_UNKNOWN')
    expect(body.details.category).toBe('animals')
    expect(body.details.allowed).toEqual(expect.arrayContaining(['animal_protection']))
    expect(body.details.allowed).toHaveLength(16)
  })

  it('rejects an empty category (TypeBox length bound, not the whitelist) → VALIDATION_FAILED', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/charities',
      query: { category: '' },
    })
    expect(res.statusCode).toBe(400)
    // Distinction from CATEGORY_UNKNOWN: an empty string fails the schema
    // length minimum, so it's a generic VALIDATION_FAILED rather than a
    // whitelist-violation domain error.
    expect((res.json() as { code: string }).code).toBe('VALIDATION_FAILED')
  })

  it('paginates correctly across 3 pages with limit=2 and emits a usable cursor', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedCharity({ name: `c-${i.toString()}` })
    }

    const page1 = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/charities',
      query: { limit: '2' },
    })
    const body1 = page1.json() as JsonBody
    expect(body1.items).toHaveLength(2)
    expect(body1.pageInfo.hasMore).toBe(true)
    expect(typeof body1.pageInfo.nextCursor).toBe('string')

    const page2 = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/charities',
      query: { limit: '2', cursor: body1.pageInfo.nextCursor! },
    })
    const body2 = page2.json() as JsonBody
    expect(body2.items).toHaveLength(2)

    const page3 = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/charities',
      query: { limit: '2', cursor: body2.pageInfo.nextCursor! },
    })
    const body3 = page3.json() as JsonBody
    expect(body3.items).toHaveLength(1)
    expect(body3.pageInfo.hasMore).toBe(false)
    expect(body3.pageInfo.nextCursor).toBeNull()

    const allIds = [...body1.items, ...body2.items, ...body3.items].map((i) => i.id as string)
    expect(new Set(allIds).size).toBe(5) // no duplicates across pages
  })

  it('rejects a malformed cursor with 400 PAGINATION_CURSOR_INVALID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/charities',
      query: { cursor: 'not!a!cursor' },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { code: string }
    expect(body.code).toBe('PAGINATION_CURSOR_INVALID')
  })

  it('a cursor pointing at a now soft-deleted row still works (resumes from neighbour)', async () => {
    for (let i = 0; i < 4; i += 1) {
      await seedCharity({ name: `row-${i.toString()}` })
    }
    const page1 = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/charities',
      query: { limit: '2' },
    })
    const body1 = page1.json() as JsonBody
    const lastId = body1.items[1]?.id as string
    await app.prisma.charity.update({ where: { id: lastId }, data: { deletedAt: past(1) } })

    const page2 = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/charities',
      query: { limit: '5', cursor: body1.pageInfo.nextCursor! },
    })
    expect(page2.statusCode).toBe(200)
    const body2 = page2.json() as JsonBody
    expect(body2.items.length).toBeGreaterThan(0)
  })
})

describe('GET /user/v1/donation/donation-projects (spec 016 + cascading visibility)', () => {
  it('hides projects whose parent Charity is expired (ADR 006 §3)', async () => {
    const liveCharity = await seedCharity({ name: 'live parent' })
    const expiredCharity = await seedCharity({
      name: 'expired parent',
      publishEndAt: past(1),
    })
    await seedProject({ charityId: liveCharity.id, name: 'visible project' })
    await seedProject({ charityId: expiredCharity.id, name: 'hidden by cascade' })

    const res = await app.inject({ method: 'GET', url: '/user/v1/donation/donation-projects' })
    const body = res.json() as JsonBody
    expect(body.items.map((i) => i.name)).toEqual(['visible project'])
  })

  it('reverse: when parent is renewed the child reappears with no batch job', async () => {
    const c = await seedCharity({ name: 'reborn', publishEndAt: past(1) })
    await seedProject({ charityId: c.id, name: 'reborn project' })

    let res = await app.inject({ method: 'GET', url: '/user/v1/donation/donation-projects' })
    expect((res.json() as JsonBody).items.map((i) => i.name)).not.toContain('reborn project')

    await app.prisma.charity.update({ where: { id: c.id }, data: { publishEndAt: future(30) } })

    // Spec 019 §8.3 — when admin PATCH charity, the cascading invalidation
    // includes the project list cache (cascading visibility). This test
    // documents the formula side (ADR 006 §3) so we simulate the write-path
    // DEL here (admin endpoint pending; otherwise TTL 30s would mask renewal).
    await app.redis.del('cache:proj:list:v1:ALL:ALL:zh-TW')
    await app.redis.del('cache:proj:list:v1:ALL:ALL:en')

    res = await app.inject({ method: 'GET', url: '/user/v1/donation/donation-projects' })
    expect((res.json() as JsonBody).items.map((i) => i.name)).toContain('reborn project')
  })

  it('?charityId filter scopes to one parent', async () => {
    const targetCharity = await seedCharity({ name: 'target' })
    const otherCharity = await seedCharity({ name: 'other' })
    await seedProject({ charityId: targetCharity.id, name: 'target P' })
    await seedProject({ charityId: otherCharity.id, name: 'other P' })

    const res = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/donation-projects',
      query: { charityId: targetCharity.id },
    })
    const body = res.json() as JsonBody
    expect(body.items.map((i) => i.name)).toEqual(['target P'])
  })

  it('Project response carries inherited categories from parent Charity', async () => {
    const cat = await seedCategory({ key: 'animal_protection' })
    const c = await seedCharity({ name: 'parent', categoryIds: [cat.id] })
    await seedProject({ charityId: c.id, name: 'project' })

    const res = await app.inject({ method: 'GET', url: '/user/v1/donation/donation-projects' })
    const body = res.json() as JsonBody
    expect(body.items[0]?.categories).toEqual([
      expect.objectContaining({ key: 'animal_protection' }),
    ])
  })
})

describe('GET /user/v1/donation/categories (spec 016 §6)', () => {
  it('lists active categories in displayOrder ASC, key ASC', async () => {
    await seedCategory({ key: 'animal_protection', displayOrder: 20 })
    await seedCategory({ key: 'child_care', displayOrder: 10 })
    const res = await app.inject({ method: 'GET', url: '/user/v1/donation/categories' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { items: { key: string }[] }
    expect(body.items.map((i) => i.key)).toEqual(['child_care', 'animal_protection'])
  })

  it('hides archived and deleted Category rows', async () => {
    await seedCategory({ key: 'child_care', displayOrder: 10 })
    await app.prisma.category.create({
      data: {
        key: 'animal_protection',
        displayName: 'animal',
        displayNameEn: 'Animal',
        displayOrder: 20,
        archivedAt: past(1),
      },
    })
    const res = await app.inject({ method: 'GET', url: '/user/v1/donation/categories' })
    const body = res.json() as { items: { key: string }[] }
    expect(body.items.map((i) => i.key)).toEqual(['child_care'])
  })

  it('sets the 5-minute public cache header with stale-while-revalidate (spec 016 §6.4 v0.13)', async () => {
    const res = await app.inject({ method: 'GET', url: '/user/v1/donation/categories' })
    expect(res.headers['cache-control']).toBe(
      'public, max-age=300, must-revalidate, stale-while-revalidate=86400',
    )
  })

  it('emits a strong ETag and short-circuits to 304 on If-None-Match match (spec 016 §6 v0.13)', async () => {
    await seedCategory({ key: 'animal_protection', displayOrder: 20 })
    await seedCategory({ key: 'child_care', displayOrder: 10 })

    const first = await app.inject({ method: 'GET', url: '/user/v1/donation/categories' })
    expect(first.statusCode).toBe(200)
    const etag = first.headers.etag as string
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/)

    const second = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/categories',
      headers: { 'if-none-match': etag },
    })
    expect(second.statusCode).toBe(304)
    expect(second.body).toBe('')
    expect(second.headers.etag).toBe(etag)
  })

  it('different locales receive different category ETags (spec 016 §8 Vary: Accept-Language)', async () => {
    await seedCategory({ key: 'child_care', displayOrder: 10 })
    const zh = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/categories',
      headers: { 'accept-language': 'zh-TW' },
    })
    const en = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/categories',
      headers: { 'accept-language': 'en' },
    })
    expect(zh.headers.etag).not.toBe(en.headers.etag)
  })
})

describe('GET /v1/donation/{resource}/:id detail (spec 017)', () => {
  it('returns the full Charity body when live', async () => {
    const cat = await seedCategory({ key: 'animal_protection' })
    const c = await seedCharity({
      name: '完整公益團體',
      categoryIds: [cat.id],
    })
    const res = await app.inject({ method: 'GET', url: `/user/v1/donation/charities/${c.id}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { id: string; name: string; categories: { key: string }[] }
    expect(body.id).toBe(c.id)
    expect(body.name).toBe('完整公益團體')
    expect(body.categories[0]?.key).toBe('animal_protection')
  })

  it('returns 404 CHARITY_NOT_FOUND for an archived Charity (lifecycle leak prevention, spec 017 §2)', async () => {
    const c = await seedCharity({ archivedAt: past(1) })
    const res = await app.inject({ method: 'GET', url: `/user/v1/donation/charities/${c.id}` })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { code: string }).code).toBe('CHARITY_NOT_FOUND')
    // Spec 017 §2 v0.6 (B3): 404 from lifecycle / cascading visibility MUST
    // NOT be cached — the parent's renewal could flip 404 → 200 within seconds.
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('returns 404 for a Project whose parent Charity is expired (Cascading visibility)', async () => {
    const c = await seedCharity({ publishEndAt: past(1) })
    const p = await seedProject({ charityId: c.id })
    const res = await app.inject({
      method: 'GET',
      url: `/user/v1/donation/donation-projects/${p.id}`,
    })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { code: string }).code).toBe('DONATION_PROJECT_NOT_FOUND')
  })

  it('rejects non-uuid :id with 400 VALIDATION_FAILED', async () => {
    const res = await app.inject({ method: 'GET', url: '/user/v1/donation/charities/not-a-uuid' })
    expect(res.statusCode).toBe(400)
  })

  it('returns 404 for a non-existent uuid', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/charities/00000000-0000-4000-8000-000000000000',
    })
    expect(res.statusCode).toBe(404)
  })

  it('Project detail nests the parent charity with id + name + logoUrl', async () => {
    const c = await seedCharity({ name: 'parent name' })
    const p = await seedProject({ charityId: c.id })
    const res = await app.inject({
      method: 'GET',
      url: `/user/v1/donation/donation-projects/${p.id}`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { charity: { id: string; name: string } }
    expect(body.charity.id).toBe(c.id)
    expect(body.charity.name).toBe('parent name')
  })

  // ── ETag + If-None-Match (spec 017 §2) ──────────────────────────────────

  it('Charity detail emits a strong ETag wrapped in double quotes', async () => {
    const c = await seedCharity({ name: 'etag charity' })
    const res = await app.inject({ method: 'GET', url: `/user/v1/donation/charities/${c.id}` })
    expect(res.statusCode).toBe(200)
    const etag = res.headers.etag
    expect(typeof etag).toBe('string')
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/)
  })

  it('If-None-Match matching the ETag → 304 with no body, ETag still set', async () => {
    const c = await seedCharity({ name: 'etag charity 2' })
    const first = await app.inject({
      method: 'GET',
      url: `/user/v1/donation/charities/${c.id}`,
    })
    const etag = first.headers.etag as string

    const second = await app.inject({
      method: 'GET',
      url: `/user/v1/donation/charities/${c.id}`,
      headers: { 'if-none-match': etag },
    })
    expect(second.statusCode).toBe(304)
    expect(second.body).toBe('')
    expect(second.headers.etag).toBe(etag)
  })

  it('If-None-Match with a stale ETag → 200 with new body + new ETag', async () => {
    const c = await seedCharity({ name: 'etag charity 3' })
    const res = await app.inject({
      method: 'GET',
      url: `/user/v1/donation/charities/${c.id}`,
      headers: { 'if-none-match': '"deadbeef00000000"' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { id: string }).id).toBe(c.id)
  })

  it('Different locales receive different ETags (spec 017 §2 — no zh/en cross-cache)', async () => {
    const c = await seedCharity({
      name: '中文名',
      nameEn: 'English name',
      description: '中',
      descriptionEn: 'En',
    })
    const zh = await app.inject({
      method: 'GET',
      url: `/user/v1/donation/charities/${c.id}`,
      headers: { 'accept-language': 'zh-TW' },
    })
    const en = await app.inject({
      method: 'GET',
      url: `/user/v1/donation/charities/${c.id}`,
      headers: { 'accept-language': 'en' },
    })
    expect(zh.headers.etag).not.toBe(en.headers.etag)
  })

  it('Project detail ETag changes when the parent Charity is updated (spec 017 §4.3)', async () => {
    const c = await seedCharity({ name: 'parent v1' })
    const p = await seedProject({ charityId: c.id })
    const first = await app.inject({
      method: 'GET',
      url: `/user/v1/donation/donation-projects/${p.id}`,
    })
    const etag1 = first.headers.etag as string

    // Bump the parent's updatedAt by renaming.
    await app.prisma.charity.update({ where: { id: c.id }, data: { name: 'parent v2' } })

    // Spec 019 §8 — with Redis cache in front, the project detail key is
    // still serving the pre-update body until TTL expires (60s) or admin
    // invalidation. This test asserts the ETag *formula* (spec 017 §4.3) —
    // so we simulate the admin-write invalidation path (spec 019 §8.3) by
    // deleting both locale variants of the cached project detail key.
    await app.redis.del(`cache:proj:detail:v1:${p.id}:zh-TW`)
    await app.redis.del(`cache:proj:detail:v1:${p.id}:en`)

    const second = await app.inject({
      method: 'GET',
      url: `/user/v1/donation/donation-projects/${p.id}`,
    })
    expect(second.headers.etag).not.toBe(etag1)
  })
})

describe('Cursor decoding via the public cursor helper round-trip', () => {
  it('encodeCursor + GET .../charities?cursor=... is the only path the client needs', async () => {
    await seedCharity({ name: 'first' })
    const cursor = encodeCursor({
      lastDisplayOrder: 0,
      lastCreatedAt: new Date(0).toISOString(),
      lastId: '00000000-0000-4000-8000-000000000000',
    })
    const res = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/charities',
      query: { cursor },
    })
    expect(res.statusCode).toBe(200)
  })
})
