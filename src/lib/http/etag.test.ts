// Spec 017 §2 — ETag helpers for conditional GET on detail endpoints.

import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'

import { buildETag, ifNoneMatch } from './etag.js'

function makeReq(ifNoneMatchHeader?: string): FastifyRequest {
  return {
    headers: ifNoneMatchHeader === undefined ? {} : { 'if-none-match': ifNoneMatchHeader },
  } as unknown as FastifyRequest
}

describe('buildETag (spec 017 §2)', () => {
  it('returns a 16-hex-char strong ETag wrapped in double quotes', () => {
    const tag = buildETag('id', new Date('2026-06-14T12:00:00.000Z'), 'zh-TW')
    expect(tag).toMatch(/^"[0-9a-f]{16}"$/)
  })

  it('is deterministic for identical inputs', () => {
    const inputs = ['abc', 'd', new Date(0), 'en']
    expect(buildETag(...inputs)).toBe(buildETag(...inputs))
  })

  it('changes when any segment differs (id)', () => {
    expect(buildETag('id-1', 'x')).not.toBe(buildETag('id-2', 'x'))
  })

  it('changes when locale changes (spec 017 §2 — zh/en must not share ETag)', () => {
    const id = '0e1b41a8-0000-4000-8000-000000000001'
    const t = new Date('2026-06-14T12:00:00.000Z')
    expect(buildETag(id, t, 'zh-TW')).not.toBe(buildETag(id, t, 'en'))
  })

  it('changes when updatedAt changes', () => {
    const id = 'x'
    const a = new Date('2026-06-14T12:00:00.000Z')
    const b = new Date('2026-06-14T12:00:00.001Z') // 1 ms apart
    expect(buildETag(id, a)).not.toBe(buildETag(id, b))
  })

  it('changes when adding a nested parent updatedAt (spec 017 §4.3 / §5.3)', () => {
    const child = buildETag('child', new Date('2026-06-14T12:00:00.000Z'), 'zh-TW')
    const childWithParent = buildETag(
      'child',
      new Date('2026-06-14T12:00:00.000Z'),
      new Date('2026-06-14T13:00:00.000Z'),
      'zh-TW',
    )
    expect(child).not.toBe(childWithParent)
  })

  it('treats null and undefined as distinct from real values and from each other', () => {
    expect(buildETag('a', null, 'b')).not.toBe(buildETag('a', undefined, 'b'))
    expect(buildETag('a', null, 'b')).not.toBe(buildETag('a', 'null', 'b'))
  })

  it('uses a separator that prevents collisions across segment boundaries', () => {
    // Without a separator, ("ab", "c") and ("a", "bc") would hash identically.
    expect(buildETag('ab', 'c')).not.toBe(buildETag('a', 'bc'))
  })
})

describe('ifNoneMatch (spec 017 §2 — conditional GET)', () => {
  const etag = '"abcdef0123456789"'

  it('returns false when the request has no If-None-Match header', () => {
    expect(ifNoneMatch(makeReq(), etag)).toBe(false)
  })

  it('returns true when the header exactly matches', () => {
    expect(ifNoneMatch(makeReq(etag), etag)).toBe(true)
  })

  it('returns false when the header points at a different ETag', () => {
    expect(ifNoneMatch(makeReq('"aaaaaaaaaaaaaaaa"'), etag)).toBe(false)
  })

  it('honours comma-separated lists (RFC 7232 §3.2)', () => {
    expect(ifNoneMatch(makeReq(`"zzzzzzzzzzzzzzzz", ${etag}`), etag)).toBe(true)
  })

  it('trims surrounding whitespace in comma-separated entries', () => {
    expect(ifNoneMatch(makeReq(`   ${etag}   `), etag)).toBe(true)
  })

  it("matches `*` (RFC 7232 §3.2 — any current representation)", () => {
    expect(ifNoneMatch(makeReq('*'), etag)).toBe(true)
  })
})
