// Spec 019 §6 — cache-aside helper.
//
// Read flow (§6.1, mirrors spec 006 §9.1 cache-aside default):
//   1. GET key
//      - hit  → deserialize → return
//      - fail → log cache_get_failed (warn) → fall through to loader (§9.1)
//   2. loader()  (called on miss OR on GET failure)
//   3. SET key value EX ttlSec
//      - fail → log cache_set_failed (warn) → return loader result anyway
//   4. return value
//
// Invariants (spec 019 §9.2):
//   - Cache failure NEVER turns into a 5xx for the caller
//   - Cache failure NEVER changes the returned shape
//   - Cache failure NEVER swallows the loader's error (it propagates)
//
// `invalidate()` is the only write-path API (§8.2): DEL + swallow errors with
// warn log; never throw. Matches spec 006 §9.2 "寫入後刪 key,不更新 key".

import type { FastifyBaseLogger } from 'fastify'
import type { Redis } from 'ioredis'

import { parseJson, stableStringify } from './json.js'

export interface CacheOptions<T> {
  redis: Redis
  key: string
  ttlSec: number
  logger: FastifyBaseLogger
  loader: () => Promise<T>
  /** Override the JSON serializer. Defaults to `stableStringify` (§7.3). */
  serialize?: (v: T) => string
  /** Override the JSON parser. Defaults to typed `parseJson<T>`. */
  deserialize?: (s: string) => T
}

export async function withCache<T>(opts: CacheOptions<T>): Promise<T> {
  const { redis, key, ttlSec, logger, loader } = opts
  const serialize = opts.serialize ?? stableStringify
  const deserialize = opts.deserialize ?? parseJson<T>

  let hit: string | null = null
  try {
    hit = await redis.get(key)
  } catch (err) {
    logger.warn(
      { err, key, event: 'cache_get_failed' },
      'cache get failed; degrading to source-of-truth',
    )
  }
  if (hit !== null) {
    return deserialize(hit)
  }

  const value = await loader()

  try {
    await redis.set(key, serialize(value), 'EX', ttlSec)
  } catch (err) {
    logger.warn(
      { err, key, event: 'cache_set_failed' },
      'cache set failed; loader result returned uncached',
    )
  }
  return value
}

export async function invalidate(
  redis: Redis,
  key: string,
  logger: FastifyBaseLogger,
): Promise<void> {
  try {
    await redis.del(key)
  } catch (err) {
    logger.warn(
      { err, key, event: 'cache_del_failed' },
      'cache invalidate failed; key may serve stale until TTL',
    )
  }
}
