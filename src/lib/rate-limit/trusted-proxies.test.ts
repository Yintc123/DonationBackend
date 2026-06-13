// Spec 010 §15.1 / spec 012 §6.1 — trusted proxy list parser.
//
// `RATE_LIMIT_TRUSTED_PROXIES` is a comma-separated list of IPs or CIDR
// ranges. We trim, drop empties, dedupe and reject the literal "*" or
// `true` — both would be equivalent to `trustProxy: true`, which spec
// 012 §6.2 explicitly forbids ("信任所有 proxy → IP 偽造").

import { describe, expect, it } from 'vitest'

import { parseTrustedProxies, TrustedProxyConfigError } from './trusted-proxies.js'

describe('parseTrustedProxies', () => {
  it('returns empty array for empty input (dev default — direct socket)', () => {
    expect(parseTrustedProxies('')).toEqual([])
    expect(parseTrustedProxies('   ')).toEqual([])
  })

  it('trims and dedupes entries, preserving first-seen order', () => {
    expect(parseTrustedProxies(' 10.0.0.0/8 , 192.168.0.0/16, 10.0.0.0/8 ')).toEqual([
      '10.0.0.0/8',
      '192.168.0.0/16',
    ])
  })

  it('accepts single IPs without a CIDR mask', () => {
    expect(parseTrustedProxies('203.0.113.10')).toEqual(['203.0.113.10'])
  })

  it('rejects "*" (would equal trustProxy: true — spec 012 §6.2)', () => {
    expect(() => parseTrustedProxies('*')).toThrow(TrustedProxyConfigError)
    expect(() => parseTrustedProxies('10.0.0.0/8,*')).toThrow(/wildcard/i)
  })

  it('rejects "true" (Fastify literal equivalent)', () => {
    expect(() => parseTrustedProxies('true')).toThrow(TrustedProxyConfigError)
  })

  it('rejects entries with whitespace inside (likely a typo / injection)', () => {
    expect(() => parseTrustedProxies('10.0.0.0 / 8')).toThrow(/invalid/i)
  })
})
