// Spec 010 §4 — rate-limit key builders.
//
// Pure helpers that construct the un-prefixed portion of the Redis key (the
// `jkod:` prefix is applied by ioredis's keyPrefix option — see spec 006 §4).
// We test the four layer key shapes from §4 plus the windowStart bucketing
// that drives the sliding window approximation (§2).

import { describe, expect, it } from 'vitest'

import {
  hashIdentifier,
  ipToSegment,
  rateLimitKey,
  routeIdFromRequest,
  windowStartMs,
} from './keys.js'

describe('windowStartMs', () => {
  it('floors the timestamp to the most recent window boundary', () => {
    expect(windowStartMs(0, 60_000)).toBe(0)
    expect(windowStartMs(59_999, 60_000)).toBe(0)
    expect(windowStartMs(60_000, 60_000)).toBe(60_000)
    expect(windowStartMs(60_001, 60_000)).toBe(60_000)
    expect(windowStartMs(180_500, 60_000)).toBe(180_000)
  })

  it('rejects non-positive windows (defensive)', () => {
    expect(() => windowStartMs(1000, 0)).toThrow(/window/i)
    expect(() => windowStartMs(1000, -1)).toThrow(/window/i)
  })
})

describe('ipToSegment', () => {
  it('replaces colons in IPv6 with dots so the key is SCAN-safe (spec 006 §4.3)', () => {
    expect(ipToSegment('2001:db8::1')).toBe('2001.db8..1')
  })

  it('passes IPv4 through unchanged', () => {
    expect(ipToSegment('203.0.113.4')).toBe('203.0.113.4')
  })

  it('rejects empty / whitespace IPs (programmer error)', () => {
    expect(() => ipToSegment('')).toThrow(/ip/i)
    expect(() => ipToSegment(' ')).toThrow(/ip/i)
  })
})

describe('hashIdentifier', () => {
  it('returns 16-char hex slice of SHA-256 (spec 010 §4.1)', () => {
    const out = hashIdentifier('user@example.com')
    expect(out).toMatch(/^[a-f0-9]{16}$/)
  })

  it('is deterministic — same input → same hash', () => {
    expect(hashIdentifier('foo')).toBe(hashIdentifier('foo'))
  })

  it('distinguishes distinct inputs', () => {
    expect(hashIdentifier('a')).not.toBe(hashIdentifier('b'))
  })
})

describe('routeIdFromRequest', () => {
  it('produces "<METHOD>:<routerPath>" (spec 010 §4.1)', () => {
    expect(routeIdFromRequest({ method: 'POST', routerPath: '/v1/auth/login' })).toBe(
      'POST:/v1/auth/login',
    )
  })

  it('upper-cases method', () => {
    expect(routeIdFromRequest({ method: 'get', routerPath: '/v1/x' })).toBe('GET:/v1/x')
  })

  it('falls back to url when routerPath is missing (404 / un-matched)', () => {
    expect(routeIdFromRequest({ method: 'GET', routerPath: undefined, url: '/missing' })).toBe(
      'GET:/missing',
    )
  })
})

describe('rateLimitKey (spec 010 §4)', () => {
  it('builds the L1 global per-IP key', () => {
    const key = rateLimitKey({
      layer: 'global',
      ip: '203.0.113.4',
      windowStartMs: 60_000,
    })
    expect(key).toBe('jkod:rate:global:ip:203.0.113.4:60000')
  })

  it('builds the L2 per-route per-IP key', () => {
    const key = rateLimitKey({
      layer: 'route-ip',
      routeId: 'POST:/v1/auth/login',
      ip: '203.0.113.4',
      windowStartMs: 60_000,
    })
    expect(key).toBe('jkod:rate:route:POST:/v1/auth/login:ip:203.0.113.4:60000')
  })

  it('builds the L3 per-route per-user key', () => {
    const key = rateLimitKey({
      layer: 'route-user',
      routeId: 'GET:/v1/profile',
      userId: 'acc_42',
      windowStartMs: 60_000,
    })
    expect(key).toBe('jkod:rate:route:GET:/v1/profile:user:acc_42:60000')
  })

  it('builds the L4 per-purpose key with hashed identifier', () => {
    const key = rateLimitKey({
      layer: 'purpose',
      purposeName: 'login_email',
      identifierHash: '0123456789abcdef',
      windowStartMs: 3_600_000,
    })
    expect(key).toBe('jkod:rate:purpose:login_email:0123456789abcdef:3600000')
  })
})
