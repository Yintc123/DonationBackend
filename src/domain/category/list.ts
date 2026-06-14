// Spec 016 §6 — categories dictionary service.
//
// 16 fixed rows (spec 015 §7.1). No publishStart/End (no contract window
// for a dictionary table — ADR 006 §決策 4). The endpoint applies only
// `deletedAt IS NULL AND archivedAt IS NULL` and returns rows ordered by
// `displayOrder ASC, key ASC`.
//
// The service returns a precomputed strong ETag alongside the items so the
// route layer can short-circuit conditional GETs (spec 016 §6 / spec 017
// §2). The ETag seed is the locale + the (id, updatedAt) tuple of every
// returned row, so any admin edit / archive / restore / displayOrder swap
// invalidates the cache deterministically without touching the route.

import type { PrismaClient } from '@prisma/client'

import { buildETag } from '../../lib/http/index.js'
import type { Locale } from '../../lib/i18n/index.js'
import { pickLocalised } from '../../lib/i18n/index.js'
import type { CategoryListItemT } from '../../schemas/category/list.js'

export interface CategoryListResult {
  items: CategoryListItemT[]
  etag: string
}

export async function listCategories(deps: {
  prisma: PrismaClient
  locale: Locale
}): Promise<CategoryListResult> {
  const rows = await deps.prisma.category.findMany({
    where: { deletedAt: null, archivedAt: null },
    orderBy: [{ displayOrder: 'asc' }, { key: 'asc' }],
  })
  const items = rows.map((r) => ({
    id: r.id,
    key: r.key,
    displayName: pickLocalised(deps.locale, { zh: r.displayName, en: r.displayNameEn }),
    displayOrder: r.displayOrder,
  }))
  // Seed: locale + every row's (id, updatedAt). `updatedAt` covers admin
  // edits (displayName / displayOrder / archivedAt toggles); `id` keeps the
  // seed stable across reorderings of equal updatedAt.
  const seed: (string | Date)[] = [deps.locale]
  for (const r of rows) {
    seed.push(r.id, r.updatedAt)
  }
  return { items, etag: buildETag(...seed) }
}
