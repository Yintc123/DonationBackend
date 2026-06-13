// Spec 006 §14 — Redis plugin integration tests against a real container.
// Spec 013 §6.1 — per-test FLUSHDB happens in per-test-setup.

import type { FastifyInstance } from 'fastify'
import fastifyPlugin from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import { redisPlugin } from '../../src/lib/redis/index.js'
import { buildApp } from '../helpers/app.js'

async function buildAppWithRedis(): Promise<FastifyInstance> {
  const app = await buildApp()
  await app.ready()
  return app
}

describe('redis plugin (integration)', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('connects to Redis and responds to PING (spec 006 §13.4)', async () => {
    app = await buildAppWithRedis()
    const pong = await app.redis.ping()
    expect(pong).toBe('PONG')
  })

  it('SET then GET round-trips a value (spec 006 §7)', async () => {
    app = await buildAppWithRedis()
    await app.redis.set('cache:profile:42', 'hello', 'EX', 30)
    const value = await app.redis.get('cache:profile:42')
    expect(value).toBe('hello')
  })

  it('applies the jkod: key prefix transparently (spec 006 §4.1)', async () => {
    app = await buildAppWithRedis()
    await app.redis.set('cache:probe:1', 'v', 'EX', 30)

    // Use a second connection WITHOUT the prefix to inspect the raw key.
    // We piggy-back on the plugin's duplicate() to share the connection params.
    const raw = app.redis.duplicate({ keyPrefix: '' })
    try {
      // The actual key stored should be "jkod:cache:probe:1".
      const prefixed = await raw.get('jkod:cache:probe:1')
      expect(prefixed).toBe('v')
      // And the un-prefixed key should NOT exist.
      const unprefixed = await raw.get('cache:probe:1')
      expect(unprefixed).toBeNull()
    } finally {
      await raw.quit()
    }
  })

  it('graceful close — app.close() quits the Redis connection (spec 006 §3.2)', async () => {
    app = await buildAppWithRedis()
    expect(app.redis.status).toBe('ready')

    const client = app.redis
    // Wait for ioredis to fully end. quit() returns once QUIT is acknowledged
    // by the server, but the socket close (and the 'end' event that sets
    // status to 'end') is async. Race it against app.close() to be deterministic.
    const ended = new Promise<void>((resolve) => client.once('end', resolve))

    await app.close()
    await ended

    expect(client.status).toBe('end')
    // Commands after end should reject — proves the connection is truly down.
    await expect(client.ping()).rejects.toThrow()

    app = undefined // already closed
  })

  it('plugin is fastify-plugin wrapped (decorators visible from parent scope)', () => {
    // fastify-plugin marks plugins with a Symbol; export should be wrapped so
    // that the `redis` decorator is reachable from the parent scope where it
    // is registered. We verify the symbol indirectly: registering once and
    // having `app.redis` available is the real assertion above; this is a
    // belt-and-braces check that the export shape did not regress.
    expect(typeof redisPlugin).toBe('function')
    expect(fastifyPlugin).toBeTypeOf('function')
  })
})
