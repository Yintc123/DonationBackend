// Spec 018 §4 — S3 config slice loader with fail-fast.

import { describe, expect, it } from 'vitest'

import { S3ConfigError, parseForcePathStyle, resolveS3Config, type S3ConfigSlice } from './config.js'

const baseSlice = (): S3ConfigSlice => ({
  S3_BUCKET: 'jko-donation-prod-assets',
  S3_REGION: 'ap-northeast-1',
  S3_ENDPOINT: '',
  S3_FORCE_PATH_STYLE: 'false',
  S3_PUBLIC_URL_BASE: '',
  S3_PRESIGN_TTL_SECONDS: 300,
  S3_MAX_UPLOAD_BYTES: 5_242_880,
})

describe('parseForcePathStyle (spec 018 §4 — strict)', () => {
  it("returns true only for the literal string 'true'", () => {
    expect(parseForcePathStyle('true')).toBe(true)
  })

  it.each(['false', '1', 'yes', 'TRUE', 'True', '', 'truthy'])(
    "returns false for %s (strict boolean parse rule)",
    (input) => {
      expect(parseForcePathStyle(input)).toBe(false)
    },
  )
})

describe('resolveS3Config (spec 018 §4.2 fail-fast)', () => {
  it('returns a normalised config when inputs are valid', () => {
    const c = resolveS3Config(baseSlice())
    expect(c.bucket).toBe('jko-donation-prod-assets')
    expect(c.region).toBe('ap-northeast-1')
    expect(c.forcePathStyle).toBe(false)
    expect(c.endpoint).toBeUndefined()
    expect(c.presignTtlSeconds).toBe(300)
    expect(c.maxUploadBytes).toBe(5_242_880)
  })

  it('throws when S3_BUCKET is empty', () => {
    expect(() => resolveS3Config({ ...baseSlice(), S3_BUCKET: '' })).toThrow(S3ConfigError)
  })

  it('throws when S3_REGION is empty', () => {
    expect(() => resolveS3Config({ ...baseSlice(), S3_REGION: '' })).toThrow(S3ConfigError)
  })

  it('rejects a bucket name containing a dot when virtual-hosted style (default)', () => {
    expect(() =>
      resolveS3Config({ ...baseSlice(), S3_BUCKET: 'my.bucket.name' }),
    ).toThrow(/dot/)
  })

  it('accepts a bucket name with a dot when path-style enabled', () => {
    const c = resolveS3Config({
      ...baseSlice(),
      S3_BUCKET: 'my.bucket.name',
      S3_FORCE_PATH_STYLE: 'true',
    })
    expect(c.forcePathStyle).toBe(true)
  })

  it('passes through endpoint when set (LocalStack)', () => {
    const c = resolveS3Config({
      ...baseSlice(),
      S3_ENDPOINT: 'http://localhost:4566',
      S3_FORCE_PATH_STYLE: 'true',
    })
    expect(c.endpoint).toBe('http://localhost:4566')
  })

  it('passes through publicUrlBase when set', () => {
    const c = resolveS3Config({
      ...baseSlice(),
      S3_PUBLIC_URL_BASE: 'https://cdn.jko-donation.com',
    })
    expect(c.publicUrlBase).toBe('https://cdn.jko-donation.com')
  })
})
