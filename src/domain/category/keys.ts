// Spec 015 v0.9 §7.1 / §7.2 — Stable Category key identifiers.
//
// `key` is a contract:
//   - Hard-coded in the seed (prisma/seed/categories.ts) — never auto-generated
//   - Referenced from spec 016 list endpoint as `?category=<key>` query param
//   - Forms the TypeScript union below for compile-time exhaustiveness
//
// Renaming a key is a breaking change for clients (filter URLs in the wild
// reference the value). Adding a key is additive but requires both:
//   1. Adding the entry below in the spec-defined display order
//   2. Updating prisma/seed/categories.ts with the matching row
// The seed sync test asserts the two stay in lockstep.

import { BadRequestError, ErrorCode } from '../../lib/errors/index.js'

export const CATEGORY_KEYS = [
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
] as const

export type CategoryKey = (typeof CATEGORY_KEYS)[number]

export function isCategoryKey(value: string): value is CategoryKey {
  return (CATEGORY_KEYS as readonly string[]).includes(value)
}

/**
 * Spec 016 §5.1 — narrow a user-supplied query value to {@link CategoryKey}
 * or throw a dedicated `CATEGORY_UNKNOWN` error.
 *
 * The category filter is intentionally NOT validated via TypeBox literal
 * union at the schema layer. Doing so would map a typo to the generic
 * `VALIDATION_FAILED` code; clients want to distinguish "stale URL /
 * deprecated key / typo" (a recoverable UX state) from "schema-level shape
 * error" (probably a bug). One dedicated code makes the branch trivial.
 */
export function parseCategoryKey(value: string | undefined): CategoryKey | undefined {
  if (value === undefined) return undefined
  if (!isCategoryKey(value)) {
    throw new BadRequestError({
      code: ErrorCode.CATEGORY_UNKNOWN,
      message: `category "${value}" is not in the whitelist`,
      details: { category: value, allowed: [...CATEGORY_KEYS] },
    })
  }
  return value
}
