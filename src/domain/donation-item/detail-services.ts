// Spec 017 §3 / §4 / §5 — detail services.
//
// Public path:
//   - Charity: findFirst({ id, ...whereLive(now) })
//   - Project / SaleItem: findFirst({ id, ...whereLiveWithParent(now) })
//   - Miss → 404 with the spec-specific code (no leak of "row exists but
//     hidden")
//
// `categories` for Project / SaleItem inherits from the parent Charity
// (spec 015 §7.4 子表繼承).

import type { PrismaClient } from '@prisma/client'

import { NotFoundError } from '../../lib/errors/index.js'
import { buildETag } from '../../lib/http/index.js'
import type { Locale } from '../../lib/i18n/index.js'
import { pickLocalised } from '../../lib/i18n/index.js'
import type {
  CharityDetailT,
  ProjectDetailT,
  SaleItemDetailT,
} from '../../schemas/donation-item/detail.js'
import { whereLive, whereLiveWithParent } from '../lifecycle/index.js'

import { inflateCategories } from './list-helpers.js'

type ObjectUrl = (key: string) => string

/**
 * Detail-service return shape: body + the precomputed strong ETag
 * (spec 017 §2). The ETag formula includes locale so zh-TW and en
 * responses never share a cached representation; for Project / SaleItem
 * it also includes the parent Charity's updatedAt because the nested
 * charity object is part of the response — when the parent renames or
 * updates its logo the child's ETag must invalidate (spec 017 §4.3 /
 * §6.2 open question, formally taken here).
 */
export interface DetailWithETag<T> {
  body: T
  etag: string
}

export async function getCharityById(deps: {
  prisma: PrismaClient
  now: Date
  locale: Locale
  objectUrl: ObjectUrl
  id: string
}): Promise<DetailWithETag<CharityDetailT>> {
  const c = await deps.prisma.charity.findFirst({
    where: { id: deps.id, ...whereLive(deps.now) },
    include: {
      categories: {
        where: { category: { deletedAt: null, archivedAt: null } },
        include: { category: true },
        orderBy: { category: { displayOrder: 'asc' } },
      },
    },
  })
  if (!c) throw new NotFoundError({ resource: 'charity', id: deps.id, code: 'CHARITY_NOT_FOUND' })

  const body: CharityDetailT = {
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
  }
  return { body, etag: buildETag(c.id, c.updatedAt, deps.locale) }
}

export async function getDonationProjectById(deps: {
  prisma: PrismaClient
  now: Date
  locale: Locale
  objectUrl: ObjectUrl
  id: string
}): Promise<DetailWithETag<ProjectDetailT>> {
  const p = await deps.prisma.donationProject.findFirst({
    where: { id: deps.id, ...whereLiveWithParent(deps.now) },
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

  const body: ProjectDetailT = {
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
  }
  return {
    body,
    etag: buildETag(p.id, p.updatedAt, p.charity.updatedAt, deps.locale),
  }
}

export async function getSaleItemById(deps: {
  prisma: PrismaClient
  now: Date
  locale: Locale
  objectUrl: ObjectUrl
  id: string
}): Promise<DetailWithETag<SaleItemDetailT>> {
  const s = await deps.prisma.saleItem.findFirst({
    where: { id: deps.id, ...whereLiveWithParent(deps.now) },
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

  const body: SaleItemDetailT = {
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
  }
  return {
    body,
    etag: buildETag(s.id, s.updatedAt, s.charity.updatedAt, deps.locale),
  }
}
