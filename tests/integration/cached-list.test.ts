// Spec 019 §6.2 / §4.2 — cached list adapters (charity / project / sale-item).
// Verifies the hot-whitelist gate (§4.2) and cache contract:
//   - Whitelisted query (no cursor, no q, no charityId, default limit): cached
//   - Non-whitelisted query: bypasses cache (§3.3 — key-explosion guard)
//   - Single-prefix raw keys (spec 006 §3)
//   - 30s TTL (spec 019 §5.1)
//   - Category and locale isolated (different cache slots)
//   - Redis down → degrades to SoT (§9.2)

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { encodeCursor } from '../../src/lib/cursor/index.js'
import { listCachedCharities } from '../../src/services/cached-charity.js'
import { listCachedDonationProjects } from '../../src/services/cached-donation-project.js'
import { listCachedSaleItems } from '../../src/services/cached-sale-item.js'
import { buildApp } from '../helpers/app.js'

const NOW = new Date('2026-06-14T12:00:00.000Z')

let app: FastifyInstance

beforeEach(async () => {
  app = await buildApp()
})

afterEach(async () => {
  await app.close()
})

async function seedCharity(name = 'C') {
  return app.prisma.charity.create({ data: { name, description: 'd' } })
}

async function seedProject(charityId: string, name = 'P') {
  return app.prisma.donationProject.create({
    data: { charityId, name, description: 'd', content: 'c' },
  })
}

async function seedSaleItem(charityId: string, name = 'I') {
  return app.prisma.saleItem.create({
    data: { charityId, name, description: 'd', content: 'c', priceTwd: 100 },
  })
}

describe('listCachedCharities (spec 019 §4.2 hot-whitelist)', () => {
  it('whitelisted query (no cursor / no q / default limit) hits cache', async () => {
    await seedCharity('A')
    const baseDeps = {
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      locale: 'zh-TW' as const,
      objectUrl: app.objectUrl,
      input: {},
    }

    const first = await listCachedCharities(baseDeps)
    expect(first.items.map((i) => i.name)).toEqual(['A'])

    await seedCharity('B') // mutate after cache populated
    const second = await listCachedCharities(baseDeps)
    expect(second.items.map((i) => i.name)).toEqual(['A']) // cache hit
  })

  it('bypasses cache when cursor present (spec 019 §3.3)', async () => {
    await seedCharity('A')
    // A cursor that yields "everything strictly after a never-existed boundary"
    // — decodes valid but matches all live rows.
    const cursor = encodeCursor({
      lastDisplayOrder: -1,
      lastCreatedAt: new Date('2000-01-01T00:00:00.000Z').toISOString(),
      lastId: '00000000-0000-4000-8000-000000000000',
    })
    const baseDeps = {
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      locale: 'zh-TW' as const,
      objectUrl: app.objectUrl,
    }

    await listCachedCharities({ ...baseDeps, input: { cursor } })
    await listCachedCharities({ ...baseDeps, input: { cursor } })

    // No cache entry should exist for any cursor query.
    const raw = app.redis.duplicate({ keyPrefix: '' })
    try {
      const keys = await raw.keys('jkod:cache:char:list:*')
      expect(keys).toHaveLength(0)
    } finally {
      await raw.quit()
    }
  })

  it('bypasses cache when q (search) present', async () => {
    await seedCharity('search-target')
    const baseDeps = {
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      locale: 'zh-TW' as const,
      objectUrl: app.objectUrl,
      input: { q: 'search' },
    }

    await listCachedCharities(baseDeps)
    const raw = app.redis.duplicate({ keyPrefix: '' })
    try {
      const keys = await raw.keys('jkod:cache:char:list:*')
      expect(keys).toHaveLength(0)
    } finally {
      await raw.quit()
    }
  })

  it('different category → different cache slot', async () => {
    await seedCharity()
    const baseDeps = {
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      locale: 'zh-TW' as const,
      objectUrl: app.objectUrl,
    }

    await listCachedCharities({ ...baseDeps, input: {} })
    await listCachedCharities({ ...baseDeps, input: { category: 'child_care' } })

    const raw = app.redis.duplicate({ keyPrefix: '' })
    try {
      expect(await raw.get('jkod:cache:char:list:v1:ALL:zh-TW')).not.toBeNull()
      expect(await raw.get('jkod:cache:char:list:v1:child_care:zh-TW')).not.toBeNull()
    } finally {
      await raw.quit()
    }
  })

  it('applies the 30s TTL (spec 019 §5.1)', async () => {
    await seedCharity()
    await listCachedCharities({
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      locale: 'zh-TW',
      objectUrl: app.objectUrl,
      input: {},
    })
    const ttl = await app.redis.ttl('cache:char:list:v1:ALL:zh-TW')
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(30)
  })

  it('Redis down → degrades to SoT', async () => {
    await seedCharity()
    const downRedis = app.redis.duplicate()
    await downRedis.quit()
    const r = await listCachedCharities({
      prisma: app.prisma,
      redis: downRedis,
      logger: app.log,
      now: NOW,
      locale: 'zh-TW',
      objectUrl: app.objectUrl,
      input: {},
    })
    expect(r.items).toHaveLength(1)
  })
})

describe('listCachedDonationProjects (spec 019 §4.2)', () => {
  it('whitelisted query hits cache; charityId filter bypasses', async () => {
    const c = await seedCharity()
    await seedProject(c.id, 'P-original')
    const baseDeps = {
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      locale: 'zh-TW' as const,
      objectUrl: app.objectUrl,
    }

    const first = await listCachedDonationProjects({ ...baseDeps, input: {} })
    expect(first.items.map((i) => i.name)).toEqual(['P-original'])

    await seedProject(c.id, 'P-new')
    const second = await listCachedDonationProjects({ ...baseDeps, input: {} })
    expect(second.items.map((i) => i.name)).toEqual(['P-original']) // cache hit

    // Same query but with charityId filter → bypass, sees both.
    const filtered = await listCachedDonationProjects({
      ...baseDeps,
      input: { charityId: c.id },
    })
    expect(filtered.items).toHaveLength(2)
  })

  it('stores under cache:proj:list:v1:{cat}:{charity}:{locale}', async () => {
    const c = await seedCharity()
    await seedProject(c.id)
    await listCachedDonationProjects({
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      locale: 'en',
      objectUrl: app.objectUrl,
      input: {},
    })
    const raw = app.redis.duplicate({ keyPrefix: '' })
    try {
      expect(await raw.get('jkod:cache:proj:list:v1:ALL:ALL:en')).not.toBeNull()
    } finally {
      await raw.quit()
    }
  })
})

describe('listCachedSaleItems (spec 019 §4.2)', () => {
  it('whitelisted query hits cache', async () => {
    const c = await seedCharity()
    await seedSaleItem(c.id, 'I-original')
    const baseDeps = {
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      locale: 'zh-TW' as const,
      objectUrl: app.objectUrl,
      input: {},
    }
    const first = await listCachedSaleItems(baseDeps)
    expect(first.items.map((i) => i.name)).toEqual(['I-original'])

    await seedSaleItem(c.id, 'I-new')
    const second = await listCachedSaleItems(baseDeps)
    expect(second.items.map((i) => i.name)).toEqual(['I-original'])
  })

  it('stores under cache:sale:list:v1:{cat}:{charity}:{locale}', async () => {
    const c = await seedCharity()
    await seedSaleItem(c.id)
    await listCachedSaleItems({
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      now: NOW,
      locale: 'zh-TW',
      objectUrl: app.objectUrl,
      input: {},
    })
    const raw = app.redis.duplicate({ keyPrefix: '' })
    try {
      expect(await raw.get('jkod:cache:sale:list:v1:ALL:ALL:zh-TW')).not.toBeNull()
    } finally {
      await raw.quit()
    }
  })
})
