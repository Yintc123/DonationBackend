// Spec 026 §5 — admin-side read services for the three donation entities.
//
// Symmetric to ./list-services.ts + ./detail-services.ts but with two
// deliberate departures (both load-bearing for the admin UX):
//
//   1. Lifecycle filter on list queries uses `whereForAdmin(opts)` instead
//      of `whereLive(now)` — admin sees rows regardless of publish window,
//      and (toggled via query flags) optionally also archived / deleted
//      rows. Cascading visibility from the parent is intentionally NOT
//      applied (spec 026 §2.3 — admins editing an archived charity's
//      still-active project is a legitimate workflow).
//
//   2. Detail lookups by id NEVER apply a lifecycle filter — admins must
//      reach archived / soft-deleted rows to edit them (spec 026 §4.2).
//      Project / SaleItem detail responses additionally expose
//      `parentCharityArchivedAt` / `parentCharityDeletedAt` so the admin
//      UI can warn the operator that the row is currently invisible in
//      public even when its own lifecycle is clean (cascading visibility,
//      spec 015 v0.9).
//
// All admin reads bypass Redis on purpose (spec 026 §2.4 / §8); no ETag
// computation, no `Cache-Control: public`. The handler layer stamps
// `no-store, private` instead.

import type { PrismaClient } from '@prisma/client'

import type { CategoryKey } from '../category/keys.js'
import type { Locale } from '../../lib/i18n/index.js'
import { decodeCursor, encodeCursor } from '../../lib/cursor/index.js'
import { NotFoundError } from '../../lib/errors/index.js'
import { pickLocalised } from '../../lib/i18n/index.js'
import type {
  AdminCharityDetailT,
  AdminProjectDetailT,
  AdminSaleItemDetailT,
} from '../../schemas/donation-item/admin-detail.js'
import type {
  AdminCharityListItemT,
  AdminProjectListItemT,
  AdminSaleItemListItemT,
} from '../../schemas/donation-item/admin-list-item.js'
import { whereForAdmin } from '../lifecycle/index.js'

import { cursorWhere, DEFAULT_LIMIT, inflateCategories } from './list-helpers.js'
import { normalizeQuery } from './normalize-query.js'

type ObjectUrl = (key: string) => string

export interface AdminListInput {
  q?: string
  category?: CategoryKey
  cursor?: string
  limit?: number
  includeArchived?: boolean
  includeDeleted?: boolean
}

export interface AdminProjectSaleListInput extends AdminListInput {
  charityId?: string
}

export interface AdminListResult<T> {
  items: T[]
  nextCursor: string | null
  hasMore: boolean
}

function adminFlagsFrom(input: AdminListInput): {
  includeArchived: boolean
  includeDeleted: boolean
} {
  return {
    includeArchived: input.includeArchived ?? false,
    includeDeleted: input.includeDeleted ?? false,
  }
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

function isoOrNull(d: Date | null): string | null {
  return d === null ? null : d.toISOString()
}

// ── Admin Charity list ────────────────────────────────────────────────────

export async function listCharitiesForAdmin(deps: {
  prisma: PrismaClient
  locale: Locale
  objectUrl: ObjectUrl
  input: AdminListInput
}): Promise<AdminListResult<AdminCharityListItemT>> {
  const limit = deps.input.limit ?? DEFAULT_LIMIT

  const filters: Record<string, unknown>[] = [whereForAdmin(adminFlagsFrom(deps.input))]
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
        where: { category: { deletedAt: null, archivedAt: null } },
        include: { category: true },
        orderBy: { category: { displayOrder: 'asc' } },
      },
    },
  })

  const hasMore = rows.length > limit
  const visible = hasMore ? rows.slice(0, limit) : rows
  const lastRow = visible[visible.length - 1]
  const nextCursor = hasMore && lastRow ? nextCursorFrom(lastRow) : null

  const items = visible.map<AdminCharityListItemT>((r) => ({
    id: r.id,
    name: pickLocalised(deps.locale, { zh: r.name, en: r.nameEn }),
    description: pickLocalised(deps.locale, { zh: r.description, en: r.descriptionEn }),
    logoUrl: r.logoKey ? deps.objectUrl(r.logoKey) : null,
    categories: inflateCategories(r.categories, deps.locale),
    displayOrder: r.displayOrder,
    publishStartAt: isoOrNull(r.publishStartAt),
    publishEndAt: isoOrNull(r.publishEndAt),
    archivedAt: isoOrNull(r.archivedAt),
    deletedAt: isoOrNull(r.deletedAt),
  }))

  return { items, nextCursor, hasMore }
}

// ── Admin DonationProject list ────────────────────────────────────────────

export async function listDonationProjectsForAdmin(deps: {
  prisma: PrismaClient
  locale: Locale
  objectUrl: ObjectUrl
  input: AdminProjectSaleListInput
}): Promise<AdminListResult<AdminProjectListItemT>> {
  const limit = deps.input.limit ?? DEFAULT_LIMIT

  const filters: Record<string, unknown>[] = [whereForAdmin(adminFlagsFrom(deps.input))]
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

  const items = visible.map<AdminProjectListItemT>((r) => ({
    id: r.id,
    name: pickLocalised(deps.locale, { zh: r.name, en: r.nameEn }),
    description: pickLocalised(deps.locale, { zh: r.description, en: r.descriptionEn }),
    logoUrl: r.logoKey ? deps.objectUrl(r.logoKey) : null,
    coverImageUrl: r.coverImageKey ? deps.objectUrl(r.coverImageKey) : null,
    charity: {
      id: r.charity.id,
      name: pickLocalised(deps.locale, { zh: r.charity.name, en: r.charity.nameEn }),
      logoUrl: r.charity.logoKey ? deps.objectUrl(r.charity.logoKey) : null,
    },
    categories: inflateCategories(r.charity.categories, deps.locale),
    displayOrder: r.displayOrder,
    publishStartAt: isoOrNull(r.publishStartAt),
    publishEndAt: isoOrNull(r.publishEndAt),
    archivedAt: isoOrNull(r.archivedAt),
    deletedAt: isoOrNull(r.deletedAt),
  }))

  return { items, nextCursor, hasMore }
}

// ── Admin SaleItem list ───────────────────────────────────────────────────

export async function listSaleItemsForAdmin(deps: {
  prisma: PrismaClient
  locale: Locale
  objectUrl: ObjectUrl
  input: AdminProjectSaleListInput
}): Promise<AdminListResult<AdminSaleItemListItemT>> {
  const limit = deps.input.limit ?? DEFAULT_LIMIT

  const filters: Record<string, unknown>[] = [whereForAdmin(adminFlagsFrom(deps.input))]
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

  const items = visible.map<AdminSaleItemListItemT>((r) => ({
    id: r.id,
    name: pickLocalised(deps.locale, { zh: r.name, en: r.nameEn }),
    description: pickLocalised(deps.locale, { zh: r.description, en: r.descriptionEn }),
    logoUrl: r.logoKey ? deps.objectUrl(r.logoKey) : null,
    coverImageUrl: r.coverImageKey ? deps.objectUrl(r.coverImageKey) : null,
    priceTwd: r.priceTwd,
    charity: {
      id: r.charity.id,
      name: pickLocalised(deps.locale, { zh: r.charity.name, en: r.charity.nameEn }),
      logoUrl: r.charity.logoKey ? deps.objectUrl(r.charity.logoKey) : null,
    },
    categories: inflateCategories(r.charity.categories, deps.locale),
    displayOrder: r.displayOrder,
    publishStartAt: isoOrNull(r.publishStartAt),
    publishEndAt: isoOrNull(r.publishEndAt),
    archivedAt: isoOrNull(r.archivedAt),
    deletedAt: isoOrNull(r.deletedAt),
  }))

  return { items, nextCursor, hasMore }
}

// ── Admin detail by id ────────────────────────────────────────────────────

export async function getCharityByIdForAdmin(deps: {
  prisma: PrismaClient
  locale: Locale
  objectUrl: ObjectUrl
  id: string
}): Promise<AdminCharityDetailT> {
  const c = await deps.prisma.charity.findUnique({
    where: { id: deps.id },
    include: {
      categories: {
        where: { category: { deletedAt: null, archivedAt: null } },
        include: { category: true },
        orderBy: { category: { displayOrder: 'asc' } },
      },
    },
  })
  if (!c)
    throw new NotFoundError({
      resource: 'charity',
      id: deps.id,
      code: 'CHARITY_NOT_FOUND',
    })

  return {
    id: c.id,
    name: pickLocalised(deps.locale, { zh: c.name, en: c.nameEn }),
    description: pickLocalised(deps.locale, { zh: c.description, en: c.descriptionEn }),
    logoUrl: c.logoKey ? deps.objectUrl(c.logoKey) : null,
    contactPhone: c.contactPhone,
    contactEmail: c.contactEmail,
    officialWebsite: c.officialWebsite,
    approvalNo: c.approvalNo,
    categories: inflateCategories(c.categories, deps.locale),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    displayOrder: c.displayOrder,
    publishStartAt: isoOrNull(c.publishStartAt),
    publishEndAt: isoOrNull(c.publishEndAt),
    archivedAt: isoOrNull(c.archivedAt),
    deletedAt: isoOrNull(c.deletedAt),
  }
}

export async function getDonationProjectByIdForAdmin(deps: {
  prisma: PrismaClient
  locale: Locale
  objectUrl: ObjectUrl
  id: string
}): Promise<AdminProjectDetailT> {
  const p = await deps.prisma.donationProject.findUnique({
    where: { id: deps.id },
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
  if (!p)
    throw new NotFoundError({
      resource: 'donation-project',
      id: deps.id,
      code: 'DONATION_PROJECT_NOT_FOUND',
    })

  return {
    id: p.id,
    name: pickLocalised(deps.locale, { zh: p.name, en: p.nameEn }),
    description: pickLocalised(deps.locale, { zh: p.description, en: p.descriptionEn }),
    logoUrl: p.logoKey ? deps.objectUrl(p.logoKey) : null,
    coverImageUrl: p.coverImageKey ? deps.objectUrl(p.coverImageKey) : null,
    content: pickLocalised(deps.locale, { zh: p.content, en: p.contentEn }),
    raisingApprovalNo: p.raisingApprovalNo,
    reliefApprovalNo: p.reliefApprovalNo,
    charity: {
      id: p.charity.id,
      name: pickLocalised(deps.locale, { zh: p.charity.name, en: p.charity.nameEn }),
      logoUrl: p.charity.logoKey ? deps.objectUrl(p.charity.logoKey) : null,
    },
    categories: inflateCategories(p.charity.categories, deps.locale),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    displayOrder: p.displayOrder,
    publishStartAt: isoOrNull(p.publishStartAt),
    publishEndAt: isoOrNull(p.publishEndAt),
    archivedAt: isoOrNull(p.archivedAt),
    deletedAt: isoOrNull(p.deletedAt),
    parentCharityArchivedAt: isoOrNull(p.charity.archivedAt),
    parentCharityDeletedAt: isoOrNull(p.charity.deletedAt),
  }
}

export async function getSaleItemByIdForAdmin(deps: {
  prisma: PrismaClient
  locale: Locale
  objectUrl: ObjectUrl
  id: string
}): Promise<AdminSaleItemDetailT> {
  const s = await deps.prisma.saleItem.findUnique({
    where: { id: deps.id },
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
  if (!s)
    throw new NotFoundError({
      resource: 'sale-item',
      id: deps.id,
      code: 'SALE_ITEM_NOT_FOUND',
    })

  return {
    id: s.id,
    name: pickLocalised(deps.locale, { zh: s.name, en: s.nameEn }),
    description: pickLocalised(deps.locale, { zh: s.description, en: s.descriptionEn }),
    logoUrl: s.logoKey ? deps.objectUrl(s.logoKey) : null,
    coverImageUrl: s.coverImageKey ? deps.objectUrl(s.coverImageKey) : null,
    content: pickLocalised(deps.locale, { zh: s.content, en: s.contentEn }),
    priceTwd: s.priceTwd,
    raisingApprovalNo: s.raisingApprovalNo,
    reliefApprovalNo: s.reliefApprovalNo,
    charity: {
      id: s.charity.id,
      name: pickLocalised(deps.locale, { zh: s.charity.name, en: s.charity.nameEn }),
      logoUrl: s.charity.logoKey ? deps.objectUrl(s.charity.logoKey) : null,
    },
    categories: inflateCategories(s.charity.categories, deps.locale),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    displayOrder: s.displayOrder,
    publishStartAt: isoOrNull(s.publishStartAt),
    publishEndAt: isoOrNull(s.publishEndAt),
    archivedAt: isoOrNull(s.archivedAt),
    deletedAt: isoOrNull(s.deletedAt),
    parentCharityArchivedAt: isoOrNull(s.charity.archivedAt),
    parentCharityDeletedAt: isoOrNull(s.charity.deletedAt),
  }
}
