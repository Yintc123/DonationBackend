// Spec 018 §5.1.1 / §7.4 — contentType whitelist + ext mapping; size limits.

import { describe, expect, it } from 'vitest'

import { AppError } from '../errors/index.js'

import {
  ALLOWED_CONTENT_TYPES,
  assertContentLength,
  assertContentType,
  contentTypeToExt,
  type AllowedContentType,
} from './policy.js'

function expectAppError(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (err) {
    if (!(err instanceof AppError)) throw new Error(`expected AppError, got: ${String(err)}`)
    expect(err.code).toBe(code)
    return
  }
  throw new Error(`expected fn to throw AppError with code ${code}`)
}

describe('contentTypeToExt (spec 018 §5.1.1)', () => {
  it('maps image/png → png', () => {
    expect(contentTypeToExt('image/png')).toBe('png')
  })

  it('maps image/jpeg → jpg (not jpeg — spec 018 §5.1.1)', () => {
    expect(contentTypeToExt('image/jpeg')).toBe('jpg')
  })

  it('maps image/webp → webp', () => {
    expect(contentTypeToExt('image/webp')).toBe('webp')
  })

  it('maps image/gif → gif', () => {
    expect(contentTypeToExt('image/gif')).toBe('gif')
  })
})

describe('ALLOWED_CONTENT_TYPES (spec 018 §7.1)', () => {
  it('contains exactly the four spec-mandated MIME types', () => {
    expect([...ALLOWED_CONTENT_TYPES].sort()).toEqual([
      'image/gif',
      'image/jpeg',
      'image/png',
      'image/webp',
    ])
  })
})

describe('assertContentType (spec 018 §7.4 → 415)', () => {
  it('returns the MIME when in the whitelist', () => {
    expect(assertContentType('image/png')).toBe<AllowedContentType>('image/png')
  })

  it('throws UNSUPPORTED_MEDIA_TYPE for unknown MIME', () => {
    expectAppError(() => assertContentType('application/pdf'), 'UNSUPPORTED_MEDIA_TYPE')
  })

  it('rejects an empty string', () => {
    expectAppError(() => assertContentType(''), 'UNSUPPORTED_MEDIA_TYPE')
  })

  it('is case-sensitive — IMAGE/PNG is rejected (MIME types are case-insensitive on the wire but normalising belongs to a higher layer)', () => {
    expectAppError(() => assertContentType('IMAGE/PNG'), 'UNSUPPORTED_MEDIA_TYPE')
  })
})

describe('assertContentLength (spec 018 §7.4 → 400)', () => {
  const MAX = 5_242_880

  it('passes a value within the limit', () => {
    expect(() => assertContentLength(1024, MAX)).not.toThrow()
  })

  it('passes at exact limit', () => {
    expect(() => assertContentLength(MAX, MAX)).not.toThrow()
  })

  it('throws VALIDATION_FAILED above limit', () => {
    expectAppError(() => assertContentLength(MAX + 1, MAX), 'VALIDATION_FAILED')
  })

  it('rejects zero / negative size (real uploads always > 0)', () => {
    expectAppError(() => assertContentLength(0, MAX), 'VALIDATION_FAILED')
    expectAppError(() => assertContentLength(-1, MAX), 'VALIDATION_FAILED')
  })

  it('rejects non-integer size (S3 ContentLength must be an integer)', () => {
    expectAppError(() => assertContentLength(12.5, MAX), 'VALIDATION_FAILED')
  })
})
