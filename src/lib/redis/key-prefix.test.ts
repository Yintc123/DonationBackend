// Spec 006 §4 — key namespace helpers (pure logic, unit-tested).
//
// Key format:   <app>:<purpose>:<sub>:<id...>
// e.g.          jkod:cache:profile:42
//               jkod:auth:refresh:tok_abc
//
// We test the building blocks here because they are PURE — no Redis I/O.
// The plugin in plugin.ts uses ioredis's `keyPrefix` option to apply the
// `<app>:` prefix automatically; these helpers cover the rest.

import { describe, expect, it } from 'vitest'

import {
  APP_PREFIX,
  buildKey,
  isValidIdentifierSegment,
  KEY_PURPOSES,
  type KeyPurpose,
} from './key-prefix.js'

describe('APP_PREFIX', () => {
  it('is "jkod" per spec 006 §4.1', () => {
    expect(APP_PREFIX).toBe('jkod')
  })
})

describe('KEY_PURPOSES', () => {
  it('contains exactly the five purposes from spec 006 §4.1 / §5', () => {
    expect([...KEY_PURPOSES].sort()).toEqual(['auth', 'cache', 'job', 'lock', 'rate'])
  })
})

describe('buildKey', () => {
  it('joins purpose + segments with colons (no app prefix — ioredis adds it)', () => {
    expect(buildKey('cache', ['profile', '42'])).toBe('cache:profile:42')
  })

  it('supports a single-segment identifier', () => {
    expect(buildKey('lock', ['donation:7'])).toBe('lock:donation:7')
  })

  it('accepts the auth tier example from spec 006 §4.2', () => {
    expect(buildKey('auth', ['refresh', 'tok_abc'])).toBe('auth:refresh:tok_abc')
  })

  it('throws when any segment is empty (spec 006 §4.3 — log readability)', () => {
    expect(() => buildKey('cache', ['profile', ''])).toThrow(/empty/i)
  })

  it('throws when any segment contains whitespace (spec 006 §4.3)', () => {
    expect(() => buildKey('cache', ['user 1'])).toThrow(/whitespace|invalid/i)
  })

  it('throws when any segment contains SCAN MATCH metacharacters (spec 006 §4.3)', () => {
    for (const bad of ['user*', 'user?', 'user[1]']) {
      expect(() => buildKey('cache', [bad])).toThrow(/invalid/i)
    }
  })

  it('throws when no segments supplied (need at least one identifier)', () => {
    expect(() => buildKey('cache' as KeyPurpose, [])).toThrow(/segment/i)
  })
})

describe('isValidIdentifierSegment', () => {
  it('accepts alphanumerics, underscore, hyphen, dot, colon', () => {
    for (const ok of ['abc', 'A_b-1.2', 'tok:xyz', 'user_42', '00000000-0000-0000-0000-000000000000']) {
      expect(isValidIdentifierSegment(ok)).toBe(true)
    }
  })

  it('rejects empty, whitespace, and SCAN metacharacters', () => {
    for (const bad of ['', ' ', 'a b', 'foo*', 'foo?', 'foo[1]', 'foo\n']) {
      expect(isValidIdentifierSegment(bad)).toBe(false)
    }
  })
})
