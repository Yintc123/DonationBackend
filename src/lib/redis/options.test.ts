// Spec 006 §3 / §11 — config → @fastify/redis plugin options mapping.
// Pure function: takes Config slice, returns the options object passed to
// fastify.register(fastifyRedis, ...). Tested in isolation.

import { describe, expect, it } from 'vitest'

import { APP_PREFIX } from './key-prefix.js'
import { buildRedisPluginOptions, type RedisConfigSlice } from './options.js'

const BASE_SLICE: RedisConfigSlice = {
  REDIS_HOST: 'localhost',
  REDIS_PORT: 6379,
  REDIS_PASSWORD: '',
}

describe('buildRedisPluginOptions', () => {
  it('passes REDIS_HOST / REDIS_PORT through as discrete options (spec 006 §3.1)', () => {
    const opts = buildRedisPluginOptions(BASE_SLICE)
    expect(opts.host).toBe('localhost')
    expect(opts.port).toBe(6379)
  })

  it('omits password when REDIS_PASSWORD is empty (no-auth Redis would reject empty AUTH)', () => {
    const opts = buildRedisPluginOptions(BASE_SLICE)
    expect(opts.password).toBeUndefined()
  })

  it('sets password when REDIS_PASSWORD is non-empty', () => {
    const opts = buildRedisPluginOptions({ ...BASE_SLICE, REDIS_PASSWORD: 'super-secret' })
    expect(opts.password).toBe('super-secret')
  })

  it('sets maxRetriesPerRequest = 3 (spec 006 §11.1)', () => {
    const opts = buildRedisPluginOptions(BASE_SLICE)
    expect(opts.maxRetriesPerRequest).toBe(3)
  })

  it('enables ready check (spec 006 §11.1)', () => {
    const opts = buildRedisPluginOptions(BASE_SLICE)
    expect(opts.enableReadyCheck).toBe(true)
  })

  it('forces eager connection — lazyConnect false (spec 006 §3.2 fail-fast)', () => {
    const opts = buildRedisPluginOptions(BASE_SLICE)
    expect(opts.lazyConnect).toBe(false)
  })

  it('applies the jkod key prefix with trailing colon (spec 006 §4.1)', () => {
    const opts = buildRedisPluginOptions(BASE_SLICE)
    expect(opts.keyPrefix).toBe(`${APP_PREFIX}:`)
  })

  it('allows callers to override the key prefix (for isolated test fixtures, spec 006 §14.3)', () => {
    const opts = buildRedisPluginOptions(BASE_SLICE, { keyPrefix: 'jkod-test:' })
    expect(opts.keyPrefix).toBe('jkod-test:')
  })
})
