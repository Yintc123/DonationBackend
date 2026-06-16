// Spec 012 §3.1 / §3.3 — CORS_ORIGIN parser.
//
// Pure function; no Fastify involved. Unit-level.

import { describe, expect, it } from 'vitest'

import { parseCorsOrigin } from './parse-origin.js'

describe('parseCorsOrigin', () => {
  it('parses a single origin → allowlist mode', () => {
    expect(parseCorsOrigin('http://localhost:3000')).toEqual({
      mode: 'allowlist',
      origins: ['http://localhost:3000'],
    })
  })

  it('parses comma-separated origins (spec 012 §3.3)', () => {
    expect(parseCorsOrigin('https://app.example.com,https://staff.example.com')).toEqual({
      mode: 'allowlist',
      origins: ['https://app.example.com', 'https://staff.example.com'],
    })
  })

  it('trims whitespace around each origin', () => {
    expect(parseCorsOrigin(' https://a.example.com , https://b.example.com ')).toEqual({
      mode: 'allowlist',
      origins: ['https://a.example.com', 'https://b.example.com'],
    })
  })

  it('deduplicates repeated origins', () => {
    expect(
      parseCorsOrigin('https://a.example.com,https://a.example.com,https://b.example.com'),
    ).toEqual({
      mode: 'allowlist',
      origins: ['https://a.example.com', 'https://b.example.com'],
    })
  })

  it('drops empty segments produced by trailing commas', () => {
    expect(parseCorsOrigin('https://a.example.com,,')).toEqual({
      mode: 'allowlist',
      origins: ['https://a.example.com'],
    })
  })

  // Spec 012 §3.2 (v0.2 — 2026-06-16):
  //   The wildcard `*` is now allowed BUT switches the cors plugin into
  //   "wildcard mode" (credentials: false). The W3C ban on `*` + credentials
  //   is enforced by deliberately dropping credentials, not by rejecting the
  //   config — the auth tokens in this backend ride the Authorization header,
  //   not cookies, so the credentials downgrade is safe.
  it('accepts "*" alone → wildcard mode', () => {
    expect(parseCorsOrigin('*')).toEqual({ mode: 'wildcard' })
  })

  it('wildcard wins when mixed with other origins (single source of truth)', () => {
    expect(parseCorsOrigin('https://a.example.com,*')).toEqual({ mode: 'wildcard' })
    expect(parseCorsOrigin('*,https://a.example.com')).toEqual({ mode: 'wildcard' })
  })

  it('rejects when no origin survives parsing', () => {
    expect(() => parseCorsOrigin('')).toThrow(/at least one/i)
    expect(() => parseCorsOrigin('   ,  ')).toThrow(/at least one/i)
  })
})
