// Spec 016 §4 — shared building blocks for the three list endpoints.
//
// Kept narrow: cursor → tiebreaker where, inflated-category projection,
// localised string selector. The three list functions assemble these into
// the entity-specific Prisma calls without reaching for a "generic"
// `listEntity<T>()` that Prisma's delegate types resist anyway.

import { type Locale, pickLocalised } from '../../lib/i18n/index.js'
import { type CursorPayload } from '../../lib/cursor/index.js'

/**
 * Spec 016 §4.5 v0.11 — build the tiebreaker `where` from a decoded cursor.
 * Layout follows the lexicographic ORDER BY (display_order ASC,
 * created_at DESC, id DESC) — i.e. "give me everything strictly AFTER
 * (displayOrder, createdAt, id)".
 */
export function cursorWhere(p: CursorPayload): {
  OR: Record<string, unknown>[]
} {
  const lastCreatedAt = new Date(p.lastCreatedAt)
  return {
    OR: [
      // Strictly greater displayOrder.
      { displayOrder: { gt: p.lastDisplayOrder } },
      // Same displayOrder, strictly earlier createdAt (DESC).
      {
        displayOrder: p.lastDisplayOrder,
        createdAt: { lt: lastCreatedAt },
      },
      // Same displayOrder + same createdAt, strictly lower id.
      {
        displayOrder: p.lastDisplayOrder,
        createdAt: lastCreatedAt,
        id: { lt: p.lastId },
      },
    ],
  }
}

/** Default page size (spec 016 §4.2 v0.3 — Figma infinite-scroll cadence). */
export const DEFAULT_LIMIT = 10

interface JoinedCategoryRow {
  category: {
    id: string
    key: string
    displayName: string
    displayNameEn: string | null
  }
}

/**
 * Build the inflated `categories[]` field from a Prisma join include,
 * respecting `Accept-Language` for displayName. spec 015 v0.7 — Category
 * 16 筆 seed 100% backfill so en branch never falls back in practice.
 */
export function inflateCategories(
  joins: JoinedCategoryRow[],
  locale: Locale,
): { id: string; key: string; displayName: string }[] {
  return joins.map((j) => ({
    id: j.category.id,
    key: j.category.key,
    displayName: pickLocalised(locale, {
      zh: j.category.displayName,
      en: j.category.displayNameEn,
    }),
  }))
}
