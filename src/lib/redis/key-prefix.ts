// Spec 006 §4 — Redis key namespace helpers.
//
// Stored key format:   <app>:<purpose>:<sub>:<id...>   e.g. jkod:cache:profile:42
// The <app> prefix is applied automatically by ioredis via `keyPrefix` (set
// in options.ts), so `buildKey` constructs ONLY the part AFTER `jkod:`.
// We still expose APP_PREFIX here as the canonical source of truth for any
// caller that needs the raw value (raw connection inspection, diagnostics).
//
// History note: a prior revision embedded APP_PREFIX in buildKey's return
// value, which caused every key to be double-prefixed in Redis as
// `jkod:jkod:...`. Reads + writes agreed on the (wrong) double key so the
// system worked, but it drifted from this comment and from spec 006 §4.1.
// The current implementation aligns impl with the documented format.

export const APP_PREFIX = 'jkod'

/** Spec 006 §4.1 / §5 — fixed purpose set; new purposes require a spec PR. */
export const KEY_PURPOSES = ['cache', 'auth', 'rate', 'lock', 'job'] as const
export type KeyPurpose = (typeof KEY_PURPOSES)[number]

// Spec 006 §4.3:
//   - no whitespace / control chars (log readability)
//   - no SCAN MATCH metacharacters: * ? [ ]
//   - non-empty
// Allow only the conservative set: alnum, _ - . :
const VALID_SEGMENT = /^[A-Za-z0-9_.:-]+$/

export function isValidIdentifierSegment(segment: string): boolean {
  if (segment.length === 0) return false
  return VALID_SEGMENT.test(segment)
}

/**
 * Build the un-prefixed portion of a Redis key.
 * ioredis prepends `${APP_PREFIX}:` automatically via the `keyPrefix` option,
 * so callers pass the returned value directly to redis.* commands.
 *
 * @example buildKey('cache', ['profile', '42']) // "cache:profile:42"
 *          // stored in Redis as "jkod:cache:profile:42"
 */
export function buildKey(purpose: KeyPurpose, segments: readonly string[]): string {
  if (segments.length === 0) {
    throw new Error('buildKey: at least one identifier segment is required')
  }
  for (const seg of segments) {
    if (seg.length === 0) {
      throw new Error(`buildKey: empty segment not allowed (purpose="${purpose}")`)
    }
    if (!isValidIdentifierSegment(seg)) {
      throw new Error(
        `buildKey: invalid segment "${seg}" — whitespace and SCAN metacharacters (* ? [ ]) are forbidden`,
      )
    }
  }
  return [purpose, ...segments].join(':')
}
