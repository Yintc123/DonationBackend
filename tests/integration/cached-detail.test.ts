// Spec 019 §6.2 — cached detail adapters for charity / project / sale-item.
// One integration test file covering all three since they share the cache
// shape (key schema char|proj|sale:detail:v1:{id}:{locale}, TTL 60s).
//
// Critical contracts:
//   - First call hits SoT, returns { body, etag } shape
//   - Second call hits cache — DB mutation between calls is invisible
//   - Locale isolated cache (zh vs en separate keys + etags)
//   - Single-prefix raw key (spec 006 §3 — no double `jkod:jkod:` drift)
//   - 60s TTL (spec 019 §5.1)
//   - NotFoundError is NOT cached (spec 019 §7.4 — 禁 negative cache)
//   - Redis down → degraded to SoT

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getCachedCharityById } from '../../src/services/cached-charity.js'
import { getCachedDonationProjectById } from '../../src/services/cached-donation-project.js'
import { getCachedSaleItemById } from '../../src/services/cached-sale-item.js'
import { buildApp } from '../helpers/app.js'

const NOW = new Date('2026-06-14T12:00:00.000Z')

let app: FastifyInstance

beforeEach(async () => {
  app = await buildApp()
})

afterEach(async () => {
  await app.close()
})

async function seedCharity(name = 'Charity A') {
  return app.prisma.charity.create({
    data: { name, description: 'd' },
  })
}

async function seedProject(charityId: string, name = 'Project A') {
  return app.prisma.donationProject.create({
    data: { charityId, name, description: 'd', content: 'c' },
  })
}

async function seedSaleItem(charityId: string, name = 'Item A') {
  return app.prisma.saleItem.create({
    data: { charityId, name, description: 'd', content: 'c', priceTwd: 100 },
  })
}

describe('getCachedCharityById (spec 019 §6.2)', () => {
  it('first call hits SoT; second call hits cache (DB mutation invisible)', async () => {
    const c = await seedCharity('original')
    const baseDeps = {
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      locale: 'zh-TW' as const,
      objectUrl: app.objectUrl,
      id: c.id,
    }

    const first = await getCachedCharityById(baseDeps)
    expect(first.body.name).toBe('original')

    await app.prisma.charity.update({
      where: { id: c.id },
      data: { name: 'changed-after-cache' },
    })

    const second = await getCachedCharityById(baseDeps)
    expect(second.body.name).toBe('original') // cache hit
    expect(second.etag).toBe(first.etag)
  })

  it('different locales cache independently', async () => {
    const c = await app.prisma.charity.create({
      data: { name: '中文', nameEn: 'English', description: 'd' },
    })
    const baseDeps = {
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      objectUrl: app.objectUrl,
      id: c.id,
    }

    const zh = await getCachedCharityById({ ...baseDeps, locale: 'zh-TW' })
    const en = await getCachedCharityById({ ...baseDeps, locale: 'en' })
    expect(zh.body.name).toBe('中文')
    expect(en.body.name).toBe('English')
    expect(zh.etag).not.toBe(en.etag)
  })

  it('stores under the canonical single-prefix raw key', async () => {
    const c = await seedCharity()
    await getCachedCharityById({
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      locale: 'zh-TW',
      objectUrl: app.objectUrl,
      id: c.id,
    })
    const raw = app.redis.duplicate({ keyPrefix: '' })
    try {
      const single = await raw.get(`jkod:cache:char:detail:v1:${c.id}:zh-TW`)
      expect(single).not.toBeNull()
    } finally {
      await raw.quit()
    }
  })

  it('applies the 60s TTL (spec 019 §5.1)', async () => {
    const c = await seedCharity()
    await getCachedCharityById({
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      locale: 'zh-TW',
      objectUrl: app.objectUrl,
      id: c.id,
    })
    const ttl = await app.redis.ttl(`cache:char:detail:v1:${c.id}:zh-TW`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(60)
  })

  it('NotFoundError is NOT cached (spec 019 §7.4 — 禁 negative cache)', async () => {
    const baseDeps = {
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      locale: 'zh-TW' as const,
      objectUrl: app.objectUrl,
      id: '11111111-1111-4111-8111-111111111111',
    }
    await expect(getCachedCharityById(baseDeps)).rejects.toThrow(/not found/i)
    // Cache must be empty.
    const cached = await app.redis.get(
      `cache:char:detail:v1:11111111-1111-4111-8111-111111111111:zh-TW`,
    )
    expect(cached).toBeNull()
  })

  it('Redis down → degrades to SoT', async () => {
    const c = await seedCharity()
    const downRedis = app.redis.duplicate()
    await downRedis.quit()

    const r = await getCachedCharityById({
      prisma: app.prisma,
      redis: downRedis,
      logger: app.log,
      now: NOW,
      locale: 'zh-TW',
      objectUrl: app.objectUrl,
      id: c.id,
    })
    expect(r.body.id).toBe(c.id)
  })
})

describe('getCachedDonationProjectById (spec 019 §6.2)', () => {
  it('caches detail by id + locale', async () => {
    const c = await seedCharity()
    const p = await seedProject(c.id, 'project-original')
    const baseDeps = {
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      locale: 'zh-TW' as const,
      objectUrl: app.objectUrl,
      id: p.id,
    }
    const first = await getCachedDonationProjectById(baseDeps)
    expect(first.body.name).toBe('project-original')

    await app.prisma.donationProject.update({
      where: { id: p.id },
      data: { name: 'project-changed' },
    })
    const second = await getCachedDonationProjectById(baseDeps)
    expect(second.body.name).toBe('project-original')
  })

  it('stores under the canonical raw key with proj: prefix', async () => {
    const c = await seedCharity()
    const p = await seedProject(c.id)
    await getCachedDonationProjectById({
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      locale: 'en',
      objectUrl: app.objectUrl,
      id: p.id,
    })
    const raw = app.redis.duplicate({ keyPrefix: '' })
    try {
      const single = await raw.get(`jkod:cache:proj:detail:v1:${p.id}:en`)
      expect(single).not.toBeNull()
    } finally {
      await raw.quit()
    }
  })
})

describe('getCachedSaleItemById (spec 019 §6.2)', () => {
  it('caches detail by id + locale', async () => {
    const c = await seedCharity()
    const s = await seedSaleItem(c.id, 'item-original')
    const baseDeps = {
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      locale: 'zh-TW' as const,
      objectUrl: app.objectUrl,
      id: s.id,
    }
    const first = await getCachedSaleItemById(baseDeps)
    expect(first.body.name).toBe('item-original')

    await app.prisma.saleItem.update({
      where: { id: s.id },
      data: { name: 'item-changed' },
    })
    const second = await getCachedSaleItemById(baseDeps)
    expect(second.body.name).toBe('item-original')
  })

  it('stores under the canonical raw key with sale: prefix', async () => {
    const c = await seedCharity()
    const s = await seedSaleItem(c.id)
    await getCachedSaleItemById({
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      locale: 'zh-TW',
      objectUrl: app.objectUrl,
      id: s.id,
    })
    const raw = app.redis.duplicate({ keyPrefix: '' })
    try {
      const single = await raw.get(`jkod:cache:sale:detail:v1:${s.id}:zh-TW`)
      expect(single).not.toBeNull()
    } finally {
      await raw.quit()
    }
  })
})
