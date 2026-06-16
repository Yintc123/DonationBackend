// Spec 009 §7.3 / §7.5 — Redis-backed idempotency response cache.
//
// Wraps the @fastify/redis client with a narrow interface so the plugin
// (which decides WHEN to look up / save) doesn't have to know the wire
// format. The store handles serialisation, TTL, and the SETNX semantics
// that resolve concurrent first-write races.
//
// Fail-open policy: when Redis is unreachable, lookup returns null and
// save returns won=false. The request still completes — clients see
// either a fresh response (if save fails) or a normal one (if lookup
// fails). Idempotency is a best-effort layer; the spec 010 rate-limit
// already enforces "Redis down → fail closed" for the platform-critical
// path, so duplicating that policy here would over-couple the system.

export interface StoredEntry {
  /** Original response status code. Replayed verbatim. */
  status: number
  /** Original response body as a JSON string. */
  body: string
  /** Original Content-Type header (preserved on replay). */
  contentType: string
  /** SHA-256 of (method, path, body). Compared on replay → §7.4 CONFLICT. */
  requestHash: string
  /** Original Location header (201 Created only). */
  location?: string
}

/** Minimal subset of ioredis.Redis we depend on, named so the store is
 *  trivially stubbable in tests. */
export interface RedisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: string[]): Promise<'OK' | null>
}

export interface IdempotencyStoreOptions {
  redis: RedisLike
  /** TTL in seconds. Spec §7.4 — fixed at 24 hours. */
  ttlSec: number
  /** Optional logger for fail-open diagnostics. */
  logger?: {
    warn(meta: Record<string, unknown>, msg: string): void
  }
}

export interface SaveResult {
  /** True iff this writer's value is what's now cached. False either
   *  because a prior writer won the SETNX race or because Redis was
   *  unreachable. */
  won: boolean
}

export interface IdempotencyStore {
  lookup(key: string): Promise<StoredEntry | null>
  save(key: string, entry: StoredEntry): Promise<SaveResult>
}

export function createIdempotencyStore(opts: IdempotencyStoreOptions): IdempotencyStore {
  const { redis, ttlSec, logger } = opts

  return {
    async lookup(key) {
      let raw: string | null
      try {
        raw = await redis.get(key)
      } catch (err) {
        logger?.warn({ err, key, event: 'idempotency_lookup_failed' }, 'idempotency lookup failed (fail-open)')
        return null
      }
      if (raw === null) return null
      try {
        const parsed = JSON.parse(raw) as StoredEntry
        // Defensive: don't trust the cached shape blindly. Anything not
        // recognisable is treated as a cache miss (spec §7.5 — losing the
        // entry is acceptable).
        if (
          typeof parsed.status !== 'number' ||
          typeof parsed.body !== 'string' ||
          typeof parsed.contentType !== 'string' ||
          typeof parsed.requestHash !== 'string'
        ) {
          return null
        }
        return parsed
      } catch {
        return null
      }
    },

    async save(key, entry) {
      const serialised = JSON.stringify(entry)
      try {
        const res = await redis.set(key, serialised, 'EX', String(ttlSec), 'NX')
        // ioredis returns 'OK' on success, null when NX rejected the write.
        return { won: res === 'OK' }
      } catch (err) {
        logger?.warn({ err, key, event: 'idempotency_save_failed' }, 'idempotency save failed (fail-open)')
        return { won: false }
      }
    },
  }
}
