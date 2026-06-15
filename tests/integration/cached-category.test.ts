// Spec 019 §6.2 — cached-category adapter integration test against real
// testcontainers Postgres + Redis. Verifies cache-aside behavior, key shape
// (single `jkod:` prefix landing in Redis), TTL, and locale isolation.

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { listCachedCategories } from '../../src/services/cached-category.js'
import { buildApp } from '../helpers/app.js'

let app: FastifyInstance

beforeEach(async () => {
  app = await buildApp()
})

afterEach(async () => {
  await app.close()
})

async function seedCategory(opts: {
  key: string
  displayName?: string
  displayNameEn?: string
  displayOrder?: number
}) {
  return app.prisma.category.create({
    data: {
      key: opts.key,
      displayName: opts.displayName ?? `display:${opts.key}`,
      displayNameEn: opts.displayNameEn ?? `Display ${opts.key}`,
      displayOrder: opts.displayOrder ?? 0,
    },
  })
}

describe('listCachedCategories (spec 019 §6.2)', () => {
  it('first call returns items + etag from the source-of-truth', async () => {
    await seedCategory({ key: 'animal_protection', displayOrder: 20 })
    await seedCategory({ key: 'child_care', displayOrder: 10 })

    const r = await listCachedCategories({
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      locale: 'zh-TW',
    })
    expect(r.items.map((i) => i.key)).toEqual(['child_care', 'animal_protection'])
    expect(r.etag).toMatch(/^"[0-9a-f]{16}"$/)
  })

  it('subsequent call hits cache — DB mutation after first call is invisible', async () => {
    await seedCategory({ key: 'k1', displayOrder: 10 })
    const first = await listCachedCategories({
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      locale: 'zh-TW',
    })
    expect(first.items).toHaveLength(1)

    // Mutate DB after the cache is populated.
    await seedCategory({ key: 'k2', displayOrder: 20 })

    const second = await listCachedCategories({
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      locale: 'zh-TW',
    })
    // Cache hit → still only the original row, AND same etag.
    expect(second.items).toHaveLength(1)
    expect(second.etag).toBe(first.etag)
  })

  it('different locales cache independently with different etags', async () => {
    await seedCategory({
      key: 'k1',
      displayName: '兒少',
      displayNameEn: 'Child Care',
      displayOrder: 10,
    })

    const zh = await listCachedCategories({
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      locale: 'zh-TW',
    })
    const en = await listCachedCategories({
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      locale: 'en',
    })
    expect(zh.items[0]?.displayName).toBe('兒少')
    expect(en.items[0]?.displayName).toBe('Child Care')
    expect(zh.etag).not.toBe(en.etag)
  })

  it('stores under the canonical single-prefix raw key (spec 019 §4 / spec 006 §3)', async () => {
    await seedCategory({ key: 'k1', displayOrder: 10 })
    await listCachedCategories({
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      locale: 'zh-TW',
    })

    const raw = app.redis.duplicate({ keyPrefix: '' })
    try {
      const single = await raw.get('jkod:cache:cat:list:v1:zh-TW')
      const doubled = await raw.get('jkod:jkod:cache:cat:list:v1:zh-TW')
      expect(single).not.toBeNull()
      expect(doubled).toBeNull()
    } finally {
      await raw.quit()
    }
  })

  it('applies the 600s TTL (spec 019 §5.1)', async () => {
    await seedCategory({ key: 'k1', displayOrder: 10 })
    await listCachedCategories({
      prisma: app.prisma,
      redis: app.redis,
      logger: app.log,
      locale: 'zh-TW',
    })
    const ttl = await app.redis.ttl('cache:cat:list:v1:zh-TW')
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(600)
  })

  it('Redis down → degrades to source-of-truth (spec 019 §9.2)', async () => {
    await seedCategory({ key: 'k1', displayOrder: 10 })

    const downRedis = app.redis.duplicate()
    await downRedis.quit()

    const r = await listCachedCategories({
      prisma: app.prisma,
      redis: downRedis,
      logger: app.log,
      locale: 'zh-TW',
    })
    expect(r.items).toHaveLength(1)
    expect(r.etag).toMatch(/^"[0-9a-f]{16}"$/)
  })
})
