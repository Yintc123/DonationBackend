// Spec 015 §7.1 — these 16 keys are the contract. The test pins the set so
// renames / additions surface in code review.

import { describe, expect, it } from 'vitest'

import { CATEGORY_KEYS, isCategoryKey } from './keys.js'

describe('CATEGORY_KEYS (spec 015 §7.1)', () => {
  it('contains exactly the 16 keys defined in spec 015 §7.1, in display order', () => {
    expect([...CATEGORY_KEYS]).toEqual([
      'child_care',
      'animal_protection',
      'special_medical',
      'elderly_care',
      'disability_service',
      'women_care',
      'sports_development',
      'education_advocacy',
      'environmental_protection',
      'diversity',
      'media',
      'public_issue',
      'arts_culture',
      'community_development',
      'poverty_relief',
      'international_aid',
    ])
  })

  it('has no duplicates (each key is unique)', () => {
    expect(new Set(CATEGORY_KEYS).size).toBe(CATEGORY_KEYS.length)
  })

  it('every key matches `[a-z][a-z_]*` (spec 015 §3.3)', () => {
    for (const key of CATEGORY_KEYS) {
      expect(key).toMatch(/^[a-z][a-z_]*$/)
      expect(key.length).toBeLessThanOrEqual(40)
    }
  })
})

describe('isCategoryKey', () => {
  it('accepts every member of CATEGORY_KEYS', () => {
    for (const key of CATEGORY_KEYS) {
      expect(isCategoryKey(key)).toBe(true)
    }
  })

  it('rejects unknown strings', () => {
    for (const bad of ['', 'animals', 'CHILD_CARE', 'child-care', '../etc']) {
      expect(isCategoryKey(bad)).toBe(false)
    }
  })
})
