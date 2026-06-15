// Spec 019 §6.1 / §9 — withCache + invalidate integration tests against a
// real testcontainer Redis (CLAUDE.md「不 mock Redis」).
//
// Covers spec 019 §12.2 must-have contracts:
//   - Cache-aside read flow (miss → loader → SET → hit)
//   - TTL applied at SET time (spec 006 §6.2)
//   - Serialization round-trip (Date → ISO string per spec 019 §7.3)
//   - Redis down → degraded to loader, no 5xx, warn log emitted (§9 不變式)
//   - Loader error propagates (no silent swallow)
//   - invalidate() DELs the key + swallows Redis errors

import type { FastifyBaseLogger } from 'fastify'
import { Redis } from 'ioredis'
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest'

import { invalidate, withCache } from '../../src/lib/cache/with-cache.js'

function makeLogger(): FastifyBaseLogger {
  const fn = vi.fn()
  const logger = {
    warn: fn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    level: 'warn',
    silent: vi.fn(),
  } as unknown as FastifyBaseLogger
  // Self-reference for child() so callers may chain without crashing the test.
  ;(logger as unknown as { child: () => FastifyBaseLogger }).child = () => logger
  return logger
}

describe('withCache (integration, spec 019 §6.1)', () => {
  let redis: Redis

  beforeEach(async () => {
    redis = new Redis({
      host: inject('TEST_REDIS_HOST'),
      port: Number(inject('TEST_REDIS_PORT')),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    })
    await redis.connect()
  })

  afterEach(async () => {
    if (redis.status !== 'end') {
      try {
        await redis.quit()
      } catch {
        /* already closed */
      }
    }
  })

  it('cache miss → loader called → SET → next GET hits', async () => {
    const loader = vi.fn().mockResolvedValue({ value: 'fresh' })
    const logger = makeLogger()

    const r1 = await withCache({
      redis,
      key: 'test:basic:v1:a',
      ttlSec: 30,
      logger,
      loader,
    })
    expect(r1).toEqual({ value: 'fresh' })
    expect(loader).toHaveBeenCalledTimes(1)

    const r2 = await withCache({
      redis,
      key: 'test:basic:v1:a',
      ttlSec: 30,
      logger,
      loader,
    })
    expect(r2).toEqual({ value: 'fresh' })
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('SET applies the ttl in one call (spec 006 §6.2 — no SET → EXPIRE two-step)', async () => {
    await withCache({
      redis,
      key: 'test:ttl:v1:a',
      ttlSec: 30,
      logger: makeLogger(),
      loader: async () => ({ x: 1 }),
    })
    const ttl = await redis.ttl('test:ttl:v1:a')
    // PERSIST = -1 (no TTL) would mean SET → EXPIRE wasn't atomic.
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(30)
  })

  it('Date serializes to ISO string and round-trips as string (spec 019 §7.3)', async () => {
    const at = new Date('2026-06-15T00:00:00.000Z')
    const logger = makeLogger()

    await withCache({
      redis,
      key: 'test:date:v1:a',
      ttlSec: 30,
      logger,
      loader: async () => ({ at }),
    })

    const r2 = await withCache<{ at: string }>({
      redis,
      key: 'test:date:v1:a',
      ttlSec: 30,
      logger,
      loader: async () => {
        throw new Error('should not be called — cache should hit')
      },
    })
    expect(r2.at).toBe('2026-06-15T00:00:00.000Z')
    expect(typeof r2.at).toBe('string')
  })

  it('preserves undefined as null in objects (spec 016 v0.13 — key 永遠存在)', async () => {
    const logger = makeLogger()
    await withCache({
      redis,
      key: 'test:undef:v1:a',
      ttlSec: 30,
      logger,
      loader: async () => ({ a: 1, b: undefined }),
    })
    const r2 = await withCache<{ a: number; b: null }>({
      redis,
      key: 'test:undef:v1:a',
      ttlSec: 30,
      logger,
      loader: async () => {
        throw new Error('should not hit loader')
      },
    })
    expect(r2).toEqual({ a: 1, b: null })
  })

  it('Redis down → loader called → result returned → warn log emitted (spec 019 §9)', async () => {
    const loader = vi.fn().mockResolvedValue({ value: 'sot' })
    const logger = makeLogger()

    await redis.quit()

    const result = await withCache({
      redis,
      key: 'test:down:v1:a',
      ttlSec: 30,
      logger,
      loader,
    })
    expect(result).toEqual({ value: 'sot' })
    expect(loader).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cache_get_failed', key: 'test:down:v1:a' }),
      expect.any(String),
    )
  })

  it('loader error propagates (no silent swallow)', async () => {
    const logger = makeLogger()
    await expect(
      withCache({
        redis,
        key: 'test:loadererr:v1:a',
        ttlSec: 30,
        logger,
        loader: async () => {
          throw new Error('loader boom')
        },
      }),
    ).rejects.toThrow('loader boom')
  })

  it('invalidate DELs the key', async () => {
    await withCache({
      redis,
      key: 'test:inv:v1:a',
      ttlSec: 30,
      logger: makeLogger(),
      loader: async () => ({ v: 1 }),
    })
    expect(await redis.get('test:inv:v1:a')).not.toBeNull()

    await invalidate(redis, 'test:inv:v1:a', makeLogger())

    expect(await redis.get('test:inv:v1:a')).toBeNull()
  })

  it('invalidate swallows redis errors and does not throw (spec 019 §9.1)', async () => {
    const logger = makeLogger()
    await redis.quit()

    await expect(
      invalidate(redis, 'test:invfail:v1:a', logger),
    ).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cache_del_failed', key: 'test:invfail:v1:a' }),
      expect.any(String),
    )
  })
})
