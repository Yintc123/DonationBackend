// Spec 007 §9.2 — pure helpers for state / nonce / PKCE generation.
//
// We test SHAPE (length / encoding / determinism of derivation), not
// randomness — randomBytes() is delegated to Node's crypto module.

import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  base64UrlEncode,
  computeCodeChallenge,
  generateNonce,
  generateState,
  generateCodeVerifier,
  timingSafeEqualStr,
} from './pkce.js'

describe('base64UrlEncode (spec 007 §9.2)', () => {
  it('should encode bytes with URL-safe alphabet and no padding', () => {
    const input = Buffer.from([0xff, 0xee, 0xdd])
    const out = base64UrlEncode(input)
    expect(out).not.toMatch(/[+/=]/)
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('generateState (spec 007 §9.2)', () => {
  it('should produce >= 32 bytes of entropy as base64url string', () => {
    const a = generateState()
    const b = generateState()
    expect(a).not.toBe(b)
    // 32 bytes → base64url length 43 (no padding)
    expect(a.length).toBeGreaterThanOrEqual(43)
    expect(a).not.toMatch(/[+/=]/)
  })
})

describe('generateNonce (spec 007 §9.2)', () => {
  it('should produce >= 32 bytes of entropy as base64url string', () => {
    const a = generateNonce()
    const b = generateNonce()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(43)
  })
})

describe('generateCodeVerifier (spec 007 §9.2)', () => {
  it('should produce >= 64 bytes of entropy as base64url string', () => {
    const a = generateCodeVerifier()
    // 64 bytes → base64url length 86 (no padding)
    expect(a.length).toBeGreaterThanOrEqual(86)
    expect(a).not.toMatch(/[+/=]/)
  })
})

describe('computeCodeChallenge (spec 007 §9.2 / RFC 7636 §4.2)', () => {
  it('should equal BASE64URL(SHA256(code_verifier))', () => {
    const verifier = 'a'.repeat(64)
    const expected = base64UrlEncode(createHash('sha256').update(verifier).digest())
    expect(computeCodeChallenge(verifier)).toBe(expected)
  })

  it('should be deterministic for the same verifier', () => {
    const v = generateCodeVerifier()
    expect(computeCodeChallenge(v)).toBe(computeCodeChallenge(v))
  })
})

describe('timingSafeEqualStr (spec 007 §9.3)', () => {
  it('should return true for identical strings', () => {
    expect(timingSafeEqualStr('abcdef', 'abcdef')).toBe(true)
  })

  it('should return false for different strings of the same length', () => {
    expect(timingSafeEqualStr('abcdef', 'abcdez')).toBe(false)
  })

  it('should return false for strings of different length without throwing', () => {
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false)
  })
})
