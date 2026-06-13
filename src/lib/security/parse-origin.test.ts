// Spec 012 §3.1 / §3.3 — CORS_ORIGIN parser.
//
// Pure function; no Fastify involved. Unit-level.

import { describe, expect, it } from 'vitest'

import { parseCorsOrigin } from './parse-origin.js'

describe('parseCorsOrigin', () => {
  it('parses a single origin', () => {
    expect(parseCorsOrigin('http://localhost:3000')).toEqual(['http://localhost:3000'])
  })

  it('parses comma-separated origins (spec 012 §3.3)', () => {
    expect(parseCorsOrigin('https://app.example.com,https://staff.example.com')).toEqual([
      'https://app.example.com',
      'https://staff.example.com',
    ])
  })

  it('trims whitespace around each origin', () => {
    expect(parseCorsOrigin(' https://a.example.com , https://b.example.com ')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ])
  })

  it('deduplicates repeated origins', () => {
    expect(
      parseCorsOrigin('https://a.example.com,https://a.example.com,https://b.example.com'),
    ).toEqual(['https://a.example.com', 'https://b.example.com'])
  })

  it('drops empty segments produced by trailing commas', () => {
    expect(parseCorsOrigin('https://a.example.com,,')).toEqual(['https://a.example.com'])
  })

  it('rejects the wildcard "*" (spec 012 §3.2)', () => {
    expect(() => parseCorsOrigin('*')).toThrow(/wildcard/i)
    expect(() => parseCorsOrigin('https://a.example.com,*')).toThrow(/wildcard/i)
  })

  it('rejects when no origin survives parsing', () => {
    expect(() => parseCorsOrigin('')).toThrow(/at least one/i)
    expect(() => parseCorsOrigin('   ,  ')).toThrow(/at least one/i)
  })
})
