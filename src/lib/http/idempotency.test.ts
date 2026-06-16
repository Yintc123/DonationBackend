// Spec 009 §7 — Idempotency-Key pure helpers.
//
// Three concerns:
//   - validateKey       — UUID v4 / ULID shape (§7.4 → 400 if neither)
//   - computeEndpointId — stable short id per (method, path)
//   - computeRequestId  — stable hash of (method, path, body) for §7.4
//                         CONFLICT detection
//   - buildStorageKey   — Redis key shape per §7.3

import { describe, expect, it } from 'vitest'

import {
  buildStorageKey,
  computeEndpointId,
  computeRequestId,
  validateKey,
} from './idempotency.js'

describe('validateKey (spec 009 §7.4)', () => {
  it.each([
    'c4b7a5e0-8d9a-4f1f-9b3a-0e2a1b9d7f23', // UUID v4
    'C4B7A5E0-8D9A-4F1F-9B3A-0E2A1B9D7F23', // uppercase variant
    '01HBP3WM3KQH8ATZ8C8B05E5MN', // ULID
    '01hbp3wm3kqh8atz8c8b05e5mn', // lowercase ULID — Crockford accepts case-insensitive
  ])('accepts well-formed key %s', (key) => {
    expect(validateKey(key).ok).toBe(true)
  })

  it.each([
    '', // empty
    'not-a-uuid',
    '01HBP3WM3KQH8ATZ8C8B05E5M', // 25 chars (ULID is 26)
    'c4b7a5e0-8d9a-3f1f-9b3a-0e2a1b9d7f23', // UUID v3 (version nibble != 4)
    'c4b7a5e0-8d9a-4f1f-7b3a-0e2a1b9d7f23', // wrong variant nibble
    '../etc/passwd', // path traversal probe
    'a'.repeat(200), // way too long
    'I0OL01HBP3WM3KQH8ATZ8C8B05', // contains I/O/L not in Crockford base32
  ])('rejects malformed key %j', (key) => {
    expect(validateKey(key).ok).toBe(false)
  })
})

describe('computeEndpointId (spec 009 §7.3)', () => {
  it('is stable: same (method, path) → same id', () => {
    expect(computeEndpointId('POST', '/v1/orders')).toBe(computeEndpointId('POST', '/v1/orders'))
  })

  it('treats method case-insensitively (HTTP methods are case-insensitive)', () => {
    expect(computeEndpointId('post', '/v1/orders')).toBe(computeEndpointId('POST', '/v1/orders'))
  })

  it('treats path case-sensitively (RFC 9110 §4.2.3 — path components are case-sensitive)', () => {
    expect(computeEndpointId('POST', '/v1/Orders')).not.toBe(computeEndpointId('POST', '/v1/orders'))
  })

  it('strips query string (idempotency is scoped to the resource, not the call)', () => {
    expect(computeEndpointId('POST', '/v1/orders?foo=bar')).toBe(
      computeEndpointId('POST', '/v1/orders'),
    )
  })

  it('different methods → different ids', () => {
    expect(computeEndpointId('POST', '/v1/orders')).not.toBe(
      computeEndpointId('PATCH', '/v1/orders'),
    )
  })

  it('produces a short hex string (≤ 32 chars) so the Redis key stays bounded', () => {
    const id = computeEndpointId('POST', '/v1/orders')
    expect(id).toMatch(/^[0-9a-f]+$/)
    expect(id.length).toBeLessThanOrEqual(32)
  })
})

describe('computeRequestId (spec 009 §7.4 CONFLICT detection)', () => {
  it('same (method, path, body) → same id', () => {
    const a = computeRequestId('POST', '/v1/orders', '{"amount":100}')
    const b = computeRequestId('POST', '/v1/orders', '{"amount":100}')
    expect(a).toBe(b)
  })

  it('different bodies → different ids', () => {
    const a = computeRequestId('POST', '/v1/orders', '{"amount":100}')
    const b = computeRequestId('POST', '/v1/orders', '{"amount":200}')
    expect(a).not.toBe(b)
  })

  it('empty body still produces a stable id (POST /action/no-body)', () => {
    const a = computeRequestId('POST', '/v1/action', '')
    const b = computeRequestId('POST', '/v1/action', '')
    expect(a).toBe(b)
  })

  it('produces a hex string', () => {
    const id = computeRequestId('POST', '/v1/orders', '{}')
    expect(id).toMatch(/^[0-9a-f]+$/)
  })
})

describe('buildStorageKey (spec 009 §7.3)', () => {
  it('formats as cache:idempotency:{endpointId}:{idemKey}', () => {
    const k = buildStorageKey('abc123', 'c4b7a5e0-8d9a-4f1f-9b3a-0e2a1b9d7f23')
    // The Redis client adds the project prefix `jkod:` itself; we return
    // the suffix.
    expect(k).toBe('cache:idempotency:abc123:c4b7a5e0-8d9a-4f1f-9b3a-0e2a1b9d7f23')
  })
})
