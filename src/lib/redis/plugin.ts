// Spec 006 §3 — Fastify Redis plugin.
//
// Responsibilities:
//   - Register @fastify/redis with config-driven options (spec 006 §3.1)
//   - Wire connection-event logs into a child logger (spec 006 §13.1)
//   - Eager connect (lazyConnect: false) for fail-fast startup (spec 006 §3.2)
//   - Graceful teardown via app.close() — @fastify/redis owns onClose
//
// We deliberately do NOT export ioredis directly; consumers go through
// `fastify.redis` (spec 006 §3.2 "業務代碼禁直接 import Redis from 'ioredis'").

import fastifyRedis from '@fastify/redis'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

import { buildRedisPluginOptions, type BuildOptions } from './options.js'

export const redisPlugin = fp(
  async (app: FastifyInstance, opts: BuildOptions = {}) => {
    const options = buildRedisPluginOptions(app.config, opts)

    await app.register(fastifyRedis, options)

    // Spec 006 §13.1 — connection events on a child logger tagged module=cache.
    const log = app.log.child({ module: 'cache' })
    app.redis.on('ready', () => {
      log.info({ event: 'cache_connected' }, 'redis ready')
    })
    app.redis.on('error', (err: Error) => {
      log.error({ event: 'cache_error', err }, 'redis error')
    })
    app.redis.on('close', () => {
      log.warn({ event: 'cache_disconnected' }, 'redis closed')
    })
    app.redis.on('reconnecting', () => {
      log.warn({ event: 'cache_reconnecting' }, 'redis reconnecting')
    })
  },
  {
    name: 'redis-plugin',
    fastify: '5.x',
    // @fastify/env decorates `app.config`; we depend on it.
    dependencies: [],
  },
)
