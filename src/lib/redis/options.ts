// Spec 006 §3 / §11 — config → @fastify/redis options.
// Pure mapper (no I/O). Plugin in plugin.ts consumes this.

import type { RedisOptions } from 'ioredis'

import { APP_PREFIX } from './key-prefix.js'

/** Subset of Config the Redis plugin needs. Keeps this module decoupled. */
export interface RedisConfigSlice {
  REDIS_URL: string
}

export interface BuildOptions {
  /** Override the default `${APP_PREFIX}:` prefix — used by test fixtures (§14.3). */
  keyPrefix?: string
}

/** Plugin options object passed to `app.register(fastifyRedis, ...)`. */
export type FastifyRedisOptions = RedisOptions & { url: string; keyPrefix: string }

export function buildRedisPluginOptions(
  config: RedisConfigSlice,
  overrides: BuildOptions = {},
): FastifyRedisOptions {
  return {
    url: config.REDIS_URL,
    // Spec 006 §11.1 — bounded retries; surface failures fast.
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    // Spec 006 §3.2 — eager connect so startup fails fast (spec 001 §1).
    lazyConnect: false,
    keyPrefix: overrides.keyPrefix ?? `${APP_PREFIX}:`,
  }
}
