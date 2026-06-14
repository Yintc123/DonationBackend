// Spec 016 §4 — list service for the three donation entities.
//
// Each service:
//   1. Decodes (or generates) the cursor.
//   2. Builds `where` = whereLive [+ parent cascade] + q ILIKE + category JOIN
//      [+ charityId filter] + cursor tiebreaker.
//   3. Runs `findMany` with the spec 016 §4.5 v0.11 ORDER BY
//      (display_order ASC, created_at DESC, id DESC), limit + 1 (peek).
//   4. Builds the next cursor from the (limit+1)th row's tuple.
//   5. Maps Prisma rows → localised list-item shape, rebuilding object URLs
//      from S3 keys via the injected `objectUrl()` callback.
//
// `objectUrl` is passed in (not imported from `lib/s3`) so the domain layer
// stays Fastify-agnostic — the route layer threads `app.objectUrl` through.

import type { PrismaClient } from '@prisma/client'

import type { CategoryKey } from '../category/keys.js'
import type { Locale } from '../../lib/i18n/index.js'
import type {
  CharityListItemT,
  ProjectListItemT,
  SaleItemListItemT,
} from '../../schemas/donation-item/list-item.js'
import { decodeCursor, encodeCursor } from '../../lib/cursor/index.js'
import { pickLocalised } from '../../lib/i18n/index.js'
import { whereLive, whereLiveWithParent } from '../lifecycle/index.js'

import { cursorWhere, DEFAULT_LIMIT, inflateCategories } from './list-helpers.js'
import { normalizeQuery } from './normalize-query.js'

type ObjectUrl = (key: string) => string

export interface ListInput {
  q?: string
  category?: CategoryKey
  cursor?: string
  limit?: number
}

export interface ProjectSaleListInput extends ListInput {
  charityId?: string
}

export interface ListResult<T> {
  items: T[]
  nextCursor: string | null
  hasMore: boolean
}

function nextCursorFrom(row: {
  displayOrder: number
  createdAt: Date
  id: string
}): string {
  return encodeCursor({
    lastDisplayOrder: row.displayOrder,
    lastCreatedAt: row.createdAt.toISOString(),
    lastId: row.id,
  })
}

function localeFieldFilter(
  locale: Locale,
  q: string,
): { OR: Record<string, unknown>[] } {
  if (locale === 'en') {
    return {
      OR: [
        { nameEn: { contains: q, mode: 'insensitive' } },
        { descriptionEn: { contains: q, mode: 'insensitive' } },
      ],
    }
  }
  return {
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ],
  }
}

// ── Charity list ──────────────────────────────────────────────────────────

export async function listCharities(deps: {
  prisma: PrismaClient
  now: Date
  locale: Locale
  objectUrl: ObjectUrl
  input: ListInput
}): Promise<ListResult<CharityListItemT>> {
  const limit = deps.input.limit ?? DEFAULT_LIMIT
  const baseWhere = whereLive(deps.now)

  const filters: Record<string, unknown>[] = [baseWhere]
  const q = normalizeQuery(deps.input.q)
  if (q) filters.push(localeFieldFilter(deps.locale, q))
  if (deps.input.category) {
    filters.push({
      categories: { some: { category: { key: deps.input.category } } },
    })
  }
  if (deps.input.cursor) filters.push(cursorWhere(decodeCursor(deps.input.cursor)))

  const rows = await deps.prisma.charity.findMany({
    where: { AND: filters },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: {
      categories: {
        where: {
          category: { deletedAt: null, archivedAt: null },
        },
        include: { category: true },
        orderBy: { category: { displayOrder: 'asc' } },
      },
    },
  })

  const hasMore = rows.length > limit
  const visible = hasMore ? rows.slice(0, limit) : rows
  const lastRow = visible[visible.length - 1]
  const nextCursor = hasMore && lastRow ? nextCursorFrom(lastRow) : null

  const items = visible.map<CharityListItemT>((r) => ({
    id: r.id,
    name: pickLocalised(deps.locale, { zh: r.name, en: r.nameEn }),
    description: pickLocalised(deps.locale, { zh: r.description, en: r.descriptionEn }),
    logoUrl: r.logoKey ? deps.objectUrl(r.logoKey) : null,
    categories: inflateCategories(r.categories, deps.locale),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }))

  return { items, nextCursor, hasMore }
}

// ── DonationProject list ──────────────────────────────────────────────────

export async function listDonationProjects(deps: {
  prisma: PrismaClient
  now: Date
  locale: Locale
  objectUrl: ObjectUrl
  input: ProjectSaleListInput
}): Promise<ListResult<ProjectListItemT>> {
  const limit = deps.input.limit ?? DEFAULT_LIMIT
  const baseWhere = whereLiveWithParent(deps.now)

  const filters: Record<string, unknown>[] = [baseWhere]
  const q = normalizeQuery(deps.input.q)
  if (q) filters.push(localeFieldFilter(deps.locale, q))
  if (deps.input.charityId) filters.push({ charityId: deps.input.charityId })
  if (deps.input.category) {
    // Inherited from parent charity (spec 015 §7.4 子表繼承).
    filters.push({
      charity: {
        is: { categories: { some: { category: { key: deps.input.category } } } },
      },
    })
  }
  if (deps.input.cursor) filters.push(cursorWhere(decodeCursor(deps.input.cursor)))

  const rows = await deps.prisma.donationProject.findMany({
    where: { AND: filters },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: {
      charity: {
        include: {
          categories: {
            where: { category: { deletedAt: null, archivedAt: null } },
            include: { category: true },
            orderBy: { category: { displayOrder: 'asc' } },
          },
        },
      },
    },
  })

  const hasMore = rows.length > limit
  const visible = hasMore ? rows.slice(0, limit) : rows
  const lastRow = visible[visible.length - 1]
  const nextCursor = hasMore && lastRow ? nextCursorFrom(lastRow) : null

  const items = visible.map<ProjectListItemT>((r) => ({
    id: r.id,
    charityId: r.charityId,
    charityName: pickLocalised(deps.locale, {
      zh: r.charity.name,
      en: r.charity.nameEn,
    }),
    name: pickLocalised(deps.locale, { zh: r.name, en: r.nameEn }),
    description: pickLocalised(deps.locale, { zh: r.description, en: r.descriptionEn }),
    logoUrl: r.logoKey ? deps.objectUrl(r.logoKey) : null,
    coverImageUrl: r.coverImageKey ? deps.objectUrl(r.coverImageKey) : null,
    // Inherited from parent.
    categories: inflateCategories(r.charity.categories, deps.locale),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }))

  return { items, nextCursor, hasMore }
}

// ── SaleItem list ─────────────────────────────────────────────────────────

export async function listSaleItems(deps: {
  prisma: PrismaClient
  now: Date
  locale: Locale
  objectUrl: ObjectUrl
  input: ProjectSaleListInput
}): Promise<ListResult<SaleItemListItemT>> {
  const limit = deps.input.limit ?? DEFAULT_LIMIT
  const baseWhere = whereLiveWithParent(deps.now)

  const filters: Record<string, unknown>[] = [baseWhere]
  const q = normalizeQuery(deps.input.q)
  if (q) filters.push(localeFieldFilter(deps.locale, q))
  if (deps.input.charityId) filters.push({ charityId: deps.input.charityId })
  if (deps.input.category) {
    filters.push({
      charity: {
        is: { categories: { some: { category: { key: deps.input.category } } } },
      },
    })
  }
  if (deps.input.cursor) filters.push(cursorWhere(decodeCursor(deps.input.cursor)))

  const rows = await deps.prisma.saleItem.findMany({
    where: { AND: filters },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: {
      charity: {
        include: {
          categories: {
            where: { category: { deletedAt: null, archivedAt: null } },
            include: { category: true },
            orderBy: { category: { displayOrder: 'asc' } },
          },
        },
      },
    },
  })

  const hasMore = rows.length > limit
  const visible = hasMore ? rows.slice(0, limit) : rows
  const lastRow = visible[visible.length - 1]
  const nextCursor = hasMore && lastRow ? nextCursorFrom(lastRow) : null

  const items = visible.map<SaleItemListItemT>((r) => ({
    id: r.id,
    charityId: r.charityId,
    charityName: pickLocalised(deps.locale, {
      zh: r.charity.name,
      en: r.charity.nameEn,
    }),
    name: pickLocalised(deps.locale, { zh: r.name, en: r.nameEn }),
    description: pickLocalised(deps.locale, { zh: r.description, en: r.descriptionEn }),
    logoUrl: r.logoKey ? deps.objectUrl(r.logoKey) : null,
    coverImageUrl: r.coverImageKey ? deps.objectUrl(r.coverImageKey) : null,
    priceTwd: r.priceTwd,
    categories: inflateCategories(r.charity.categories, deps.locale),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }))

  return { items, nextCursor, hasMore }
}
