// Spec 012 §6.5.2 — X-Request-Id safety validation.
//
// Pins the contract: accept inbound IDs that match charset + length rules
// (charset prevents log injection / header smuggling, length lower bound
// prevents low-entropy "magic IDs" used to game log/metric filters).
//
// History: spec 012 v0.3 (this commit) relaxed the prior UUID-v4-only rule
// (which broke BFF correlation when BFFs use non-UUID formats like
// `req_YYYY-MM-DD_<suffix>`). See spec 012 §6.5.3 for the full rationale.

import { describe, expect, it } from 'vitest'

import { REQUEST_ID_HEADER, isValidRequestId } from './request-id.js'

describe('REQUEST_ID_HEADER', () => {
  it('should be the lower-case canonical header name', () => {
    // Fastify normalises inbound header keys to lower-case; matching that
    // case here means lookups can be a direct string compare.
    expect(REQUEST_ID_HEADER).toBe('x-request-id')
  })
})

describe('isValidRequestId (spec 012 §6.5.2)', () => {
  describe('accepts ids that pass charset + length', () => {
    it.each<[string, string]>([
      ['UUID v4', 'c4b7a5e0-8d9a-4f1f-9b3a-0e2a1b9d7f23'],
      // UUID v1 (version nibble = 1) — accepted; spec 012 §6.5.3 explicitly
      // drops version-specific checks (the prior anti-forgery rationale is
      // already covered by length + entropy of the random suffix).
      ['UUID v1', 'c4b7a5e0-8d9a-1f1f-9b3a-0e2a1b9d7f23'],
      // BFF format per spec 012 §6.5.4 example — the canonical motivating
      // case for this relaxation.
      ['BFF req_YYYY-MM-DD_<suffix>', 'req_2026-06-17_AbCd1234'],
      // ULID — common alternative to UUID, also base32-ish.
      ['ULID-shaped', '01HF7G2K3M4N5P6Q7R8S9T0V1W'],
      // Length boundary: exactly 16 chars (the minimum).
      ['exactly 16 chars', 'abcdef0123456789'],
      // Length boundary: exactly 128 chars (the maximum).
      ['exactly 128 chars', 'a'.repeat(128)],
    ])('should accept %s', (_label, value) => {
      expect(isValidRequestId(value)).toBe(true)
    })
  })

  describe('rejects ids that fail length bounds', () => {
    it.each<[string, string]>([
      ['empty string', ''],
      ['15 chars (one below minimum)', 'abcdef012345678'],
      ['129 chars (one above maximum)', 'a'.repeat(129)],
    ])('should reject %s', (_label, value) => {
      expect(isValidRequestId(value)).toBe(false)
    })
  })

  describe('rejects ids that fail charset', () => {
    it.each<[string, string]>([
      // Log injection — \n could forge log entries (spec 012 §6.5.3).
      ['contains newline', 'real-id\nfake=admin user'],
      // Header smuggling / separator chars.
      ['contains space', 'with space xxxxxxxx'],
      ['contains colon', 'prefix:value_xxxxx'],
      ['contains equals', 'key=value_xxxxxxxx'],
      ['contains semicolon', 'a;b_xxxxxxxxxxxxx'],
      // Dot is common in trace IDs but we exclude it — the spec keeps the
      // charset to base64url-compatible (`[A-Za-z0-9_-]`).
      ['contains dot', 'a.b.c_xxxxxxxxxxx'],
      // Unicode — outside ASCII charset; would survive logging but breaks
      // grep/diagnostic tooling assumptions.
      ['contains unicode', 'req_中文_xxxxxxxxx'],
    ])('should reject %s', (_label, value) => {
      expect(isValidRequestId(value)).toBe(false)
    })
  })

  describe('rejects non-string inputs', () => {
    it.each<[string, unknown]>([
      ['undefined', undefined],
      ['null', null],
      ['number', 1234567890123456],
      ['array', ['abcdef0123456789']],
      ['object', { value: 'abcdef0123456789' }],
    ])('should reject %s', (_label, value) => {
      expect(isValidRequestId(value)).toBe(false)
    })
  })

  it('should narrow the type to string when it returns true', () => {
    const candidate: unknown = 'c4b7a5e0-8d9a-4f1f-9b3a-0e2a1b9d7f23'
    if (isValidRequestId(candidate)) {
      // Compile-time check: this assignment only typechecks if the predicate
      // narrowed `candidate` from unknown to string.
      const asString: string = candidate
      expect(asString.length).toBeGreaterThan(0)
    } else {
      // Should not reach here for a valid input; assert to fail loudly.
      expect.fail('expected predicate to narrow valid UUID')
    }
  })
})
