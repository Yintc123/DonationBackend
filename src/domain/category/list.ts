// Spec 016 §6 — categories dictionary service.
//
// 16 fixed rows (spec 015 §7.1). No publishStart/End (no contract window
// for a dictionary table — ADR 006 §決策 4). The endpoint applies only
// `deletedAt IS NULL AND archivedAt IS NULL` and returns rows ordered by
// `displayOrder ASC, key ASC`.

import type { PrismaClient } from '@prisma/client'

import type { Locale } from '../../lib/i18n/index.js'
import { pickLocalised } from '../../lib/i18n/index.js'
import type { CategoryListItemT } from '../../schemas/category/list.js'

export async function listCategories(deps: {
  prisma: PrismaClient
  locale: Locale
}): Promise<CategoryListItemT[]> {
  const rows = await deps.prisma.category.findMany({
    where: { deletedAt: null, archivedAt: null },
    orderBy: [{ displayOrder: 'asc' }, { key: 'asc' }],
  })
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    displayName: pickLocalised(deps.locale, { zh: r.displayName, en: r.displayNameEn }),
    displayOrder: r.displayOrder,
  }))
}
