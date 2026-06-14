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
