// Spec 015 §7.1 — 16 fixed Category rows.
//
// `key` is the contract identifier (src/domain/category/keys.ts pins the
// list at compile time). `displayOrder` uses 10-multiples so future inserts
// can slot in the middle without renumbering.
//
// Idempotent: each row is upsert-by-key, so re-running just refreshes the
// translatable fields without rotating the auto-generated uuid.

import type { PrismaClient } from '@prisma/client'

import { CATEGORY_KEYS, type CategoryKey } from '../../src/domain/category/keys.js'

interface CategorySeed {
  key: CategoryKey
  displayName: string
  displayNameEn: string
  displayOrder: number
}

const CATEGORIES: readonly CategorySeed[] = [
  { key: 'child_care',               displayName: '兒少照護',     displayNameEn: 'Child Care',               displayOrder: 10 },
  { key: 'animal_protection',        displayName: '動物保護',     displayNameEn: 'Animal Protection',        displayOrder: 20 },
  { key: 'special_medical',          displayName: '特殊醫病',     displayNameEn: 'Special Medical Care',     displayOrder: 30 },
  { key: 'elderly_care',             displayName: '老人照護',     displayNameEn: 'Elderly Care',             displayOrder: 40 },
  { key: 'disability_service',       displayName: '身心障礙服務', displayNameEn: 'Disability Service',       displayOrder: 50 },
  { key: 'women_care',               displayName: '婦女關懷',     displayNameEn: 'Women Care',               displayOrder: 60 },
  { key: 'sports_development',       displayName: '運動發展',     displayNameEn: 'Sports Development',       displayOrder: 70 },
  { key: 'education_advocacy',       displayName: '教育議題提倡', displayNameEn: 'Education Advocacy',       displayOrder: 80 },
  { key: 'environmental_protection', displayName: '環境保護',     displayNameEn: 'Environmental Protection', displayOrder: 90 },
  { key: 'diversity',                displayName: '多元族群',     displayNameEn: 'Diversity',                displayOrder: 100 },
  { key: 'media',                    displayName: '媒體傳播',     displayNameEn: 'Media',                    displayOrder: 110 },
  { key: 'public_issue',             displayName: '公共議題',     displayNameEn: 'Public Issues',            displayOrder: 120 },
  { key: 'arts_culture',             displayName: '文教藝術',     displayNameEn: 'Arts & Culture',           displayOrder: 130 },
  { key: 'community_development',    displayName: '社區發展',     displayNameEn: 'Community Development',    displayOrder: 140 },
  { key: 'poverty_relief',           displayName: '弱勢扶貧',     displayNameEn: 'Poverty Relief',           displayOrder: 150 },
  { key: 'international_aid',        displayName: '國際救援',     displayNameEn: 'International Aid',        displayOrder: 160 },
]

// Compile-time check: the seeder array stays aligned with CATEGORY_KEYS.
if (CATEGORIES.length !== CATEGORY_KEYS.length) {
  throw new Error(
    `seed/categories.ts: row count ${CATEGORIES.length.toString()} != CATEGORY_KEYS count ${CATEGORY_KEYS.length.toString()}`,
  )
}

export async function seedCategories(prisma: PrismaClient): Promise<Map<CategoryKey, string>> {
  const idByKey = new Map<CategoryKey, string>()
  for (const c of CATEGORIES) {
    const row = await prisma.category.upsert({
      where: { key: c.key },
      create: {
        key: c.key,
        displayName: c.displayName,
        displayNameEn: c.displayNameEn,
        displayOrder: c.displayOrder,
      },
      update: {
        displayName: c.displayName,
        displayNameEn: c.displayNameEn,
        displayOrder: c.displayOrder,
      },
    })
    idByKey.set(c.key, row.id)
  }
  return idByKey
}
