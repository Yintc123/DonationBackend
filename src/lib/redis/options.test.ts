// Spec 006 §3 / §11 — config → @fastify/redis plugin options mapping.
// Pure function: takes Config, returns the options object passed to
// fastify.register(fastifyRedis, ...). Tested in isolation.

import { describe, expect, it } from 'vitest'

import { APP_PREFIX } from './key-prefix.js'
import { buildRedisPluginOptions } from './options.js'

const BASE_URL = 'redis://localhost:6379'

describe('buildRedisPluginOptions', () => {
  it('passes REDIS_URL through as `url` (spec 006 §3.1)', () => {
    const opts = buildRedisPluginOptions({ REDIS_URL: BASE_URL })
    expect(opts.url).toBe(BASE_URL)
  })

  it('sets maxRetriesPerRequest = 3 (spec 006 §11.1)', () => {
    const opts = buildRedisPluginOptions({ REDIS_URL: BASE_URL })
    expect(opts.maxRetriesPerRequest).toBe(3)
  })

  it('enables ready check (spec 006 §11.1)', () => {
    const opts = buildRedisPluginOptions({ REDIS_URL: BASE_URL })
    expect(opts.enableReadyCheck).toBe(true)
  })

  it('forces eager connection — lazyConnect false (spec 006 §3.2 fail-fast)', () => {
    const opts = buildRedisPluginOptions({ REDIS_URL: BASE_URL })
    expect(opts.lazyConnect).toBe(false)
  })

  it('applies the jkod key prefix with trailing colon (spec 006 §4.1)', () => {
    const opts = buildRedisPluginOptions({ REDIS_URL: BASE_URL })
    expect(opts.keyPrefix).toBe(`${APP_PREFIX}:`)
  })

  it('allows callers to override the key prefix (for isolated test fixtures, spec 006 §14.3)', () => {
    const opts = buildRedisPluginOptions({ REDIS_URL: BASE_URL }, { keyPrefix: 'jkod-test:' })
    expect(opts.keyPrefix).toBe('jkod-test:')
  })
})
