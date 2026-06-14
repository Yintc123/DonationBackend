// Spec 006 §3 / §11 — config → @fastify/redis options.
// Pure mapper (no I/O). Plugin in plugin.ts consumes this.
//
// We pass discrete `{ host, port, password }` to ioredis rather than
// composing a URL — passwords with `@` / `:` / `/` etc. then need no
// percent-encoding, and there's no synthesised intermediate value to keep
// in sync (cf. DATABASE_URL which Prisma CLI demands).

import type { RedisOptions } from 'ioredis'

import { APP_PREFIX } from './key-prefix.js'

/** Subset of Config the Redis plugin needs. Keeps this module decoupled. */
export interface RedisConfigSlice {
  REDIS_HOST: string
  REDIS_PORT: number
  REDIS_PASSWORD: string
}

export interface BuildOptions {
  /** Override the default `${APP_PREFIX}:` prefix — used by test fixtures (§14.3). */
  keyPrefix?: string
}

/** Plugin options object passed to `app.register(fastifyRedis, ...)`. */
export type FastifyRedisOptions = RedisOptions & {
  host: string
  port: number
  keyPrefix: string
}

export function buildRedisPluginOptions(
  config: RedisConfigSlice,
  overrides: BuildOptions = {},
): FastifyRedisOptions {
  const options: FastifyRedisOptions = {
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    // Spec 006 §11.1 — bounded retries; surface failures fast.
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    // Spec 006 §3.2 — eager connect so startup fails fast (spec 001 §1).
    lazyConnect: false,
    keyPrefix: overrides.keyPrefix ?? `${APP_PREFIX}:`,
  }
  // Only set `password` when present — ioredis treats an empty-string password
  // as "send AUTH command with empty password", which a no-auth Redis rejects.
  if (config.REDIS_PASSWORD) {
    options.password = config.REDIS_PASSWORD
  }
  return options
}
