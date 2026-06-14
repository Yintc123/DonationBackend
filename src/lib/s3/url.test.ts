// Spec 018 §8 — objectUrl() builds the public read URL for an object key.

import { describe, expect, it } from 'vitest'

import { objectUrl, type ObjectUrlConfig } from './url.js'

const BASE_CONFIG: ObjectUrlConfig = {
  bucket: 'jko-donation-prod-assets',
  region: 'ap-northeast-1',
  publicUrlBase: '',
  forcePathStyle: false,
}

describe('objectUrl (spec 018 §8.1)', () => {
  it('uses virtual-hosted style by default', () => {
    expect(objectUrl('donation/charities/abc/logo.png', BASE_CONFIG)).toBe(
      'https://jko-donation-prod-assets.s3.ap-northeast-1.amazonaws.com/donation/charities/abc/logo.png',
    )
  })

  it('honours an explicit S3_PUBLIC_URL_BASE (CDN override)', () => {
    expect(
      objectUrl('donation/charities/abc/logo.png', {
        ...BASE_CONFIG,
        publicUrlBase: 'https://cdn.jko-donation.com',
      }),
    ).toBe('https://cdn.jko-donation.com/donation/charities/abc/logo.png')
  })

  it('strips a trailing slash from publicUrlBase so the result has no //', () => {
    expect(
      objectUrl('donation/charities/abc/logo.png', {
        ...BASE_CONFIG,
        publicUrlBase: 'https://cdn.jko-donation.com/',
      }),
    ).toBe('https://cdn.jko-donation.com/donation/charities/abc/logo.png')
  })

  it('uses path-style URL when forcePathStyle (LocalStack / MinIO)', () => {
    expect(
      objectUrl('donation/charities/abc/logo.png', {
        ...BASE_CONFIG,
        forcePathStyle: true,
      }),
    ).toBe(
      'https://s3.ap-northeast-1.amazonaws.com/jko-donation-prod-assets/donation/charities/abc/logo.png',
    )
  })

  it('publicUrlBase wins over forcePathStyle (explicit CDN base is final)', () => {
    expect(
      objectUrl('donation/charities/abc/logo.png', {
        ...BASE_CONFIG,
        forcePathStyle: true,
        publicUrlBase: 'https://cdn.jko-donation.com',
      }),
    ).toBe('https://cdn.jko-donation.com/donation/charities/abc/logo.png')
  })
})
