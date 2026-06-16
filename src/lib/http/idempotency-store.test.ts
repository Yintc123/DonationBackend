// Spec 009 §7.3 / §7.5 — Redis-backed idempotency cache.
//
// Unit-test the store behaviour against an injectable Redis stub so we
// can cover edge cases (TTL expiry, SETNX race) without spinning up the
// container. Integration coverage of the full plugin chain lives in
// tests/integration/idempotency.test.ts.

import { describe, expect, it, vi } from 'vitest'

import { createIdempotencyStore, type StoredEntry } from './idempotency-store.js'

function makeRedisStub() {
  // Map<key, { value, expiresAt }>. `set(key, value, 'EX', ttl, 'NX')` is
  // the only setter we use; `get(key)` returns string | null. This stub
  // covers exactly that surface.
  const store = new Map<string, { value: string; expiresAt: number }>()
  let now = 1_000_000
  return {
    advance: (ms: number) => {
      now += ms
    },
    setNow: (ms: number) => {
      now = ms
    },
    get(key: string): Promise<string | null> {
      const entry = store.get(key)
      if (!entry) return Promise.resolve(null)
      if (entry.expiresAt <= now) {
        store.delete(key)
        return Promise.resolve(null)
      }
      return Promise.resolve(entry.value)
    },
    // ioredis set signature: set(key, value, mode, ttl, nxFlag)
    set: vi.fn(async (key: string, value: string, ...args: string[]): Promise<'OK' | null> => {
      let ttlSec = Number.POSITIVE_INFINITY
      let nx = false
      for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if (a === 'EX') {
          ttlSec = Number(args[i + 1])
          i++
        } else if (a === 'NX') {
          nx = true
        }
      }
      if (nx && store.has(key)) {
        const e = store.get(key)
        if (e && e.expiresAt > now) return null
      }
      store.set(key, { value, expiresAt: now + ttlSec * 1000 })
      return 'OK'
    }),
  }
}

const SAMPLE_ENTRY: StoredEntry = {
  status: 201,
  body: '{"id":"abc"}',
  contentType: 'application/json; charset=utf-8',
  requestHash: 'deadbeef',
  location: '/v1/orders/abc',
}

describe('createIdempotencyStore (spec 009 §7.3)', () => {
  it('lookup() returns null when no entry is cached', async () => {
    const redis = makeRedisStub()
    const store = createIdempotencyStore({ redis, ttlSec: 86400 })
    expect(await store.lookup('cache:idempotency:abc:def')).toBeNull()
  })

  it('save() then lookup() returns the same entry', async () => {
    const redis = makeRedisStub()
    const store = createIdempotencyStore({ redis, ttlSec: 86400 })
    const saved = await store.save('cache:idempotency:abc:def', SAMPLE_ENTRY)
    expect(saved.won).toBe(true)
    const got = await store.lookup('cache:idempotency:abc:def')
    expect(got).toEqual(SAMPLE_ENTRY)
  })

  it('save() uses SETNX semantics — second writer for the same key returns won=false', async () => {
    const redis = makeRedisStub()
    const store = createIdempotencyStore({ redis, ttlSec: 86400 })
    const a = await store.save('cache:idempotency:abc:def', SAMPLE_ENTRY)
    const b = await store.save('cache:idempotency:abc:def', {
      ...SAMPLE_ENTRY,
      body: '{"different":true}',
    })
    expect(a.won).toBe(true)
    expect(b.won).toBe(false)
    // The cached body is the FIRST writer's, not the second's.
    const got = await store.lookup('cache:idempotency:abc:def')
    expect(got?.body).toBe(SAMPLE_ENTRY.body)
  })

  it('save() respects ttlSec (entry expires after the window)', async () => {
    const redis = makeRedisStub()
    const store = createIdempotencyStore({ redis, ttlSec: 60 })
    await store.save('cache:idempotency:abc:def', SAMPLE_ENTRY)
    redis.advance(59_000)
    expect(await store.lookup('cache:idempotency:abc:def')).toEqual(SAMPLE_ENTRY)
    redis.advance(2_000)
    expect(await store.lookup('cache:idempotency:abc:def')).toBeNull()
  })

  it('lookup() returns null when Redis is unreachable (fail-open)', async () => {
    const redis = makeRedisStub()
    const failing = {
      ...redis,
      get: () => Promise.reject(new Error('ECONNREFUSED')),
    }
    const storeWithFailingGet = createIdempotencyStore({ redis: failing, ttlSec: 86400 })
    expect(await storeWithFailingGet.lookup('cache:idempotency:abc:def')).toBeNull()
  })

  it('save() returns won=false (and does not throw) when Redis is unreachable', async () => {
    const redis = makeRedisStub()
    redis.set.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const store = createIdempotencyStore({ redis, ttlSec: 86400 })
    const result = await store.save('cache:idempotency:abc:def', SAMPLE_ENTRY)
    expect(result.won).toBe(false)
  })
})
