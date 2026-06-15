// Spec 020 §8 / spec 019 §8.3 — key-enumeration contract for the donation
// admin write cache invalidator. We unit-test the pure key list (no Redis)
// so a regression in the cascading rule fails loudly in CI.
//
// The actual DEL pipeline (`invalidateDonationEntity`) is exercised in the
// integration tests when admin endpoints land (per backend CLAUDE.md "不
// mock Redis" — integration is where we touch the real container).

import { describe, expect, it } from 'vitest'

import { CATEGORY_KEYS } from '../../domain/category/keys.js'

import { donationCacheKeysFor } from './invalidate-donation.js'

const SLOTS = ['ALL', ...CATEGORY_KEYS]
const LOCALES = ['zh-TW', 'en']

describe('donationCacheKeysFor — charity', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const keys = donationCacheKeysFor({ entity: 'charity', id })

  it('includes detail keys in both locales', () => {
    expect(keys).toContain(`cache:char:detail:v1:${id}:zh-TW`)
    expect(keys).toContain(`cache:char:detail:v1:${id}:en`)
  })

  it('includes every char:list slot (17 categories × 2 locales = 34)', () => {
    for (const slot of SLOTS) {
      for (const loc of LOCALES) {
        expect(keys).toContain(`cache:char:list:v1:${slot}:${loc}`)
      }
    }
  })

  it('cascades to project list scoped to (this charity, ALL) — 17 × 2 × 2 = 68', () => {
    for (const charityScope of [id, 'ALL']) {
      for (const slot of SLOTS) {
        for (const loc of LOCALES) {
          expect(keys).toContain(`cache:proj:list:v1:${slot}:${charityScope}:${loc}`)
        }
      }
    }
  })

  it('cascades to sale list scoped to (this charity, ALL)', () => {
    for (const charityScope of [id, 'ALL']) {
      for (const slot of SLOTS) {
        for (const loc of LOCALES) {
          expect(keys).toContain(`cache:sale:list:v1:${slot}:${charityScope}:${loc}`)
        }
      }
    }
  })

  it('emits no duplicates', () => {
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('does not touch other-charity-scoped list keys', () => {
    const stranger = '22222222-2222-4222-8222-222222222222'
    for (const slot of SLOTS) {
      for (const loc of LOCALES) {
        expect(keys).not.toContain(`cache:proj:list:v1:${slot}:${stranger}:${loc}`)
        expect(keys).not.toContain(`cache:sale:list:v1:${slot}:${stranger}:${loc}`)
      }
    }
  })
})

describe('donationCacheKeysFor — project', () => {
  const id = '33333333-3333-4333-8333-333333333333'
  const parentCharityId = '44444444-4444-4444-8444-444444444444'

  it('includes own detail in both locales + list scoped to (parent, ALL)', () => {
    const keys = donationCacheKeysFor({ entity: 'project', id, parentCharityId })
    expect(keys).toContain(`cache:proj:detail:v1:${id}:zh-TW`)
    expect(keys).toContain(`cache:proj:detail:v1:${id}:en`)
    for (const charityScope of [parentCharityId, 'ALL']) {
      for (const slot of SLOTS) {
        for (const loc of LOCALES) {
          expect(keys).toContain(`cache:proj:list:v1:${slot}:${charityScope}:${loc}`)
        }
      }
    }
  })

  it('does NOT cascade to charity list / sale list', () => {
    const keys = donationCacheKeysFor({ entity: 'project', id, parentCharityId })
    expect(keys.some((k) => k.startsWith('cache:char:list:v1'))).toBe(false)
    expect(keys.some((k) => k.startsWith('cache:sale:list:v1'))).toBe(false)
  })

  it('still hits the ALL slot when parentCharityId is missing (degrades gracefully)', () => {
    const keys = donationCacheKeysFor({ entity: 'project', id })
    expect(keys.some((k) => k.includes(`:list:v1:`) && k.includes(':ALL:'))).toBe(true)
  })
})

describe('donationCacheKeysFor — sale', () => {
  it('mirrors the project pattern with sale namespace', () => {
    const id = '55555555-5555-4555-8555-555555555555'
    const parentCharityId = '66666666-6666-4666-8666-666666666666'
    const keys = donationCacheKeysFor({ entity: 'sale', id, parentCharityId })
    expect(keys).toContain(`cache:sale:detail:v1:${id}:zh-TW`)
    expect(keys).toContain(`cache:sale:detail:v1:${id}:en`)
    for (const charityScope of [parentCharityId, 'ALL']) {
      for (const slot of SLOTS) {
        for (const loc of LOCALES) {
          expect(keys).toContain(`cache:sale:list:v1:${slot}:${charityScope}:${loc}`)
        }
      }
    }
    expect(keys.some((k) => k.startsWith('cache:proj:list:v1'))).toBe(false)
  })
})

describe('donationCacheKeysFor — category', () => {
  it('only invalidates the cat:list keys per locale (worst-case cascade left to TTL)', () => {
    const keys = donationCacheKeysFor({ entity: 'category', id: '' })
    expect(keys).toEqual([
      'cache:cat:list:v1:zh-TW',
      'cache:cat:list:v1:en',
    ])
  })
})
