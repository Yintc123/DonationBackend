// Spec 019 §4 — buildCacheKey returns the key WITHOUT the `jkod:` app prefix
// (ioredis applies it via `keyPrefix` per spec 006 §3). Stored key is therefore
// `jkod:cache:<resource>:<sub>:v{n}:<segments...>`.
//
// Enforces:
//   1. Format `cache:<resource>:<sub>:v{n}:<segments...>` (§4.1)
//   2. `:v{n}` version segment (§4.3) — schema bumps replace SCAN-based purge
//   3. spec 006 §4.3 segment rules (no empty / whitespace / SCAN metachars)

import { describe, expect, it } from 'vitest'

import { buildCacheKey } from './keys.js'

describe('buildCacheKey', () => {
  it('builds the categories dictionary key (spec 019 §4.1)', () => {
    expect(buildCacheKey('cat:list:v1', ['zh-TW'])).toBe(
      'cache:cat:list:v1:zh-TW',
    )
  })

  it('builds a detail key with id + locale (spec 019 §4.1)', () => {
    expect(buildCacheKey('proj:detail:v1', ['abc-123', 'en'])).toBe(
      'cache:proj:detail:v1:abc-123:en',
    )
  })

  it('builds a list key with multiple data segments (spec 019 §4.1)', () => {
    expect(buildCacheKey('proj:list:v1', ['ALL', 'ALL', 'zh-TW'])).toBe(
      'cache:proj:list:v1:ALL:ALL:zh-TW',
    )
  })

  it('supports schema version bumps (spec 019 §4.3)', () => {
    expect(buildCacheKey('cat:list:v2', ['zh-TW'])).toBe(
      'cache:cat:list:v2:zh-TW',
    )
  })

  it('throws when schema is missing the v{n} version segment (spec 019 §4.3)', () => {
    expect(() => buildCacheKey('cat:list', ['zh-TW'])).toThrow(/version/i)
  })

  it('throws when schema version segment is malformed', () => {
    for (const bad of ['cat:list:v', 'cat:list:v0', 'cat:list:vX', 'cat:list:1', 'cat:list:V1']) {
      expect(() => buildCacheKey(bad, ['zh-TW'])).toThrow(/version/i)
    }
  })

  it('throws when schema has fewer than 3 segments (need <resource>:<sub>:v{n})', () => {
    expect(() => buildCacheKey('v1', ['zh-TW'])).toThrow(/schema/i)
    expect(() => buildCacheKey('cat:v1', ['zh-TW'])).toThrow(/schema/i)
  })

  it('throws when schema is empty', () => {
    expect(() => buildCacheKey('', ['zh-TW'])).toThrow(/schema/i)
  })

  it('throws when no data segments supplied (need at least one identifier)', () => {
    expect(() => buildCacheKey('cat:list:v1', [])).toThrow(/segment/i)
  })

  it('rejects empty data segments (spec 006 §4.3)', () => {
    expect(() => buildCacheKey('proj:detail:v1', ['abc', ''])).toThrow(/empty/i)
  })

  it('rejects data segments with SCAN metacharacters (spec 006 §4.3)', () => {
    for (const bad of ['a*b', 'a?b', 'a[1]b']) {
      expect(() => buildCacheKey('proj:detail:v1', [bad, 'en'])).toThrow(/invalid/i)
    }
  })

  it('rejects schema segments with SCAN metacharacters', () => {
    expect(() => buildCacheKey('proj*:detail:v1', ['x', 'en'])).toThrow(/invalid/i)
  })

  it('rejects empty schema segments', () => {
    expect(() => buildCacheKey('proj::v1', ['x', 'en'])).toThrow(/empty/i)
    expect(() => buildCacheKey(':detail:v1', ['x', 'en'])).toThrow(/empty/i)
  })
})
