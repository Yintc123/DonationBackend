// Spec 019 §4 — buildCacheKey: cache namespace key assembler.
//
// Schema format: `<resource>:<sub>:v{n}` (e.g. `proj:detail:v1`).
// Returned key:  `cache:<resource>:<sub>:v{n}:<segments...>`
// Stored key:    `jkod:cache:<resource>:<sub>:v{n}:<segments...>`
//                (ioredis applies `keyPrefix: 'jkod:'` from spec 006 §3)
//
// The `:v{n}` version segment lets us bump on response-shape breaking changes
// without SCAN MATCH purges (spec 019 §4.3) — old keys naturally expire by TTL.
//
// Segment validation is delegated to buildKey which centralises the regex
// (no whitespace, no SCAN metacharacters per spec 006 §4.3).

import { buildKey } from '../redis/index.js'

const VERSION_PATTERN = /^v[1-9]\d*$/

/**
 * Build a Redis cache key (without the `jkod:` app prefix — ioredis adds it).
 *
 * @param schema    Colon-joined `<resource>:<sub>:v{n}` (n ≥ 1).
 * @param segments  Data identifier segments (e.g. `[id, locale]`); ≥ 1 required.
 */
export function buildCacheKey(
  schema: string,
  segments: readonly string[],
): string {
  if (schema.length === 0) {
    throw new Error('buildCacheKey: schema must be non-empty')
  }
  const schemaSegments = schema.split(':')
  const last = schemaSegments[schemaSegments.length - 1]
  if (last === undefined || !VERSION_PATTERN.test(last)) {
    throw new Error(
      `buildCacheKey: schema must end with version segment "v{n}" (n ≥ 1); got "${schema}"`,
    )
  }
  if (schemaSegments.length < 3) {
    throw new Error(
      `buildCacheKey: schema must have ≥ 3 segments "<resource>:<sub>:v{n}"; got "${schema}"`,
    )
  }
  if (segments.length === 0) {
    throw new Error('buildCacheKey: at least one data segment is required')
  }
  return buildKey('cache', [...schemaSegments, ...segments])
}
