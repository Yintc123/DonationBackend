// Spec 020 §5.1 — Charity admin write services.
//
// Five flows in one file because they all touch the same row + categories
// join + cache invalidate + audit log:
//   createCharity   POST   §5.1.1
//   updateCharity   PATCH  §5.1.2
//   archive/unarchive/softDelete/restore — routed to the shared factory in
//     ./lifecycle-actions.ts (spec 020 §7)
//
// We deliberately do NOT go through `cached-charity` for the post-write
// response: the row we just wrote is fresh, an extra cache miss + repopulate
// only adds latency. Public reads will get the new shape via TTL or via the
// invalidate-donation pipeline DEL we just issued.

import type { Charity, Prisma, PrismaClient } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import type { Redis } from 'ioredis'

import { BadRequestError, ErrorCode, NotFoundError } from '../../lib/errors/index.js'
import { invalidateDonationEntity } from '../../lib/cache/invalidate-donation.js'
import { assertValidObjectKey } from '../../lib/s3/index.js'
import type { Clock } from '../../lib/clock.js'
import { type Locale, pickLocalised } from '../../lib/i18n/index.js'

import { inflateCategories } from './list-helpers.js'
import type { CharityDetailT } from '../../schemas/donation-item/detail.js'

type ObjectUrl = (key: string) => string

export interface CharityWriteDeps {
  prisma: PrismaClient
  redis: Redis
  logger: FastifyBaseLogger
  clock: Clock
  locale: Locale
  objectUrl: ObjectUrl
}

// Body shape — the route layer's TypeBox already enforces field-level
// constraints. Service does the cross-field invariants + DB writes.
export interface CharityCreateInput {
  name: string
  description: string
  nameEn?: string | null
  descriptionEn?: string | null
  contactPhone?: string | null
  contactEmail?: string | null
  officialWebsite?: string | null
  approvalNo?: string | null
  logoKey?: string | null
  displayOrder?: number
  publishStartAt?: string | null
  publishEndAt?: string | null
  categoryIds?: readonly string[]
}

export interface CharityPatchInput {
  name?: string
  description?: string
  nameEn?: string | null
  descriptionEn?: string | null
  contactPhone?: string | null
  contactEmail?: string | null
  officialWebsite?: string | null
  approvalNo?: string | null
  logoKey?: string | null
  displayOrder?: number
  publishStartAt?: string | null
  publishEndAt?: string | null
  categoryIds?: readonly string[]
}

// ── Shared helpers ─────────────────────────────────────────────────────────

/**
 * spec 020 §6 — publishStartAt < publishEndAt invariant. Either may be null;
 * both null = always live. Service-layer rule, not TypeBox.
 */
function assertPublishRange(start: string | null | undefined, end: string | null | undefined): void {
  if (start == null || end == null) return
  if (new Date(start) >= new Date(end)) {
    throw new BadRequestError({
      code: ErrorCode.INVALID_LIFECYCLE_RANGE,
      message: 'publishStartAt must be strictly before publishEndAt',
    })
  }
}

/**
 * spec 020 §5.1 — categoryIds must all refer to live Category rows. Empty
 * input is allowed (means "no categories"). Throws CHARITY_CATEGORY_INVALID
 * the moment any id is missing or non-live so we don't end up with partial
 * join rows.
 */
async function assertCategoriesLive(
  prisma: Prisma.TransactionClient | PrismaClient,
  categoryIds: readonly string[],
): Promise<void> {
  if (categoryIds.length === 0) return
  const found = await prisma.category.findMany({
    where: { id: { in: [...categoryIds] }, archivedAt: null, deletedAt: null },
    select: { id: true },
  })
  if (found.length !== categoryIds.length) {
    const validSet = new Set(found.map((c) => c.id))
    const missing = categoryIds.filter((id) => !validSet.has(id))
    throw new BadRequestError({
      code: ErrorCode.CHARITY_CATEGORY_INVALID,
      message: 'one or more categoryIds are unknown or not live',
      details: { missing },
    })
  }
}

/**
 * spec 020 §2.8 / §9 — backend does NOT verify S3 object existence (one round
 * trip + spec 018 §11 alignment). We only verify the key shape matches the
 * donation/{entity}/{id}/{purpose}.{ext} contract. Entity / id binding is
 * left loose (admin demo scope — see ADR 013 trade-off discussion).
 */
function assertLogoKeyShape(key: string | null | undefined): void {
  if (key == null) return
  assertValidObjectKey(key, '/logoKey')
}

function parseDate(iso: string | null | undefined): Date | null | undefined {
  if (iso === undefined) return undefined
  if (iso === null) return null
  return new Date(iso)
}

interface HydratedCharityRow {
  charity: Charity
  categories: {
    category: { id: string; key: string; displayName: string; displayNameEn: string | null }
  }[]
}

/** Build the CharityDetail response from a hydrated row. */
function buildResponse(deps: CharityWriteDeps, row: HydratedCharityRow): CharityDetailT {
  const c = row.charity
  return {
    id: c.id,
    name: pickLocalised(deps.locale, { zh: c.name, en: c.nameEn }),
    description: pickLocalised(deps.locale, { zh: c.description, en: c.descriptionEn }),
    logoUrl: c.logoKey ? deps.objectUrl(c.logoKey) : null,
    contactPhone: c.contactPhone,
    contactEmail: c.contactEmail,
    officialWebsite: c.officialWebsite,
    approvalNo: c.approvalNo,
    categories: inflateCategories(row.categories, deps.locale),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }
}

async function loadHydrated(
  prisma: Prisma.TransactionClient | PrismaClient,
  id: string,
): Promise<HydratedCharityRow | null> {
  const row = await prisma.charity.findUnique({
    where: { id },
    include: {
      categories: {
        // Admin response keeps the "live category" filter (spec 020 §5.4)
        // so the inflated dictionary stays consistent with public reads.
        where: { category: { deletedAt: null, archivedAt: null } },
        include: { category: true },
        orderBy: { category: { displayOrder: 'asc' } },
      },
    },
  })
  if (row === null) return null
  return { charity: row, categories: row.categories }
}

// ── createCharity (spec 020 §5.1.1) ────────────────────────────────────────

export async function createCharity(
  deps: CharityWriteDeps,
  input: CharityCreateInput,
): Promise<CharityDetailT> {
  assertPublishRange(input.publishStartAt, input.publishEndAt)
  assertLogoKeyShape(input.logoKey)

  const categoryIds = input.categoryIds ?? []
  await assertCategoriesLive(deps.prisma, categoryIds)

  const row = await deps.prisma.$transaction(async (tx) => {
    const created = await tx.charity.create({
      data: {
        name: input.name,
        description: input.description,
        nameEn: input.nameEn ?? null,
        descriptionEn: input.descriptionEn ?? null,
        contactPhone: input.contactPhone ?? null,
        contactEmail: input.contactEmail ?? null,
        officialWebsite: input.officialWebsite ?? null,
        approvalNo: input.approvalNo ?? null,
        logoKey: input.logoKey ?? null,
        displayOrder: input.displayOrder ?? 0,
        publishStartAt: parseDate(input.publishStartAt) ?? undefined,
        publishEndAt: parseDate(input.publishEndAt) ?? undefined,
      },
    })
    if (categoryIds.length > 0) {
      await tx.charityOnCategory.createMany({
        data: categoryIds.map((categoryId) => ({ charityId: created.id, categoryId })),
      })
    }
    const hydrated = await loadHydrated(tx, created.id)
    if (hydrated === null) {
      // Should be impossible inside the same transaction.
      throw new Error('createCharity: row vanished mid-transaction')
    }
    return hydrated
  })

  await invalidateDonationEntity({
    redis: deps.redis,
    logger: deps.logger,
    entity: 'charity',
    id: row.charity.id,
  })
  deps.logger.info({ event: 'donation_charity_created', entityId: row.charity.id, audit: true })

  return buildResponse(deps, row)
}

// ── updateCharity (spec 020 §5.1.2) ────────────────────────────────────────

export async function updateCharity(
  deps: CharityWriteDeps,
  id: string,
  input: CharityPatchInput,
): Promise<CharityDetailT> {
  assertPublishRange(input.publishStartAt, input.publishEndAt)
  assertLogoKeyShape(input.logoKey)
  if (input.categoryIds !== undefined) {
    await assertCategoriesLive(deps.prisma, input.categoryIds)
  }

  const row = await deps.prisma.$transaction(async (tx) => {
    const existing = await tx.charity.findUnique({ where: { id }, select: { id: true } })
    if (existing === null) {
      throw new NotFoundError({ resource: 'charity', id, code: ErrorCode.CHARITY_NOT_FOUND })
    }

    await tx.charity.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description,
        nameEn: input.nameEn,
        descriptionEn: input.descriptionEn,
        contactPhone: input.contactPhone,
        contactEmail: input.contactEmail,
        officialWebsite: input.officialWebsite,
        approvalNo: input.approvalNo,
        logoKey: input.logoKey,
        displayOrder: input.displayOrder,
        publishStartAt: parseDate(input.publishStartAt),
        publishEndAt: parseDate(input.publishEndAt),
      },
    })

    if (input.categoryIds !== undefined) {
      // spec 020 §5.1.2 — categoryIds is FULL REPLACE: drop all, re-insert.
      await tx.charityOnCategory.deleteMany({ where: { charityId: id } })
      if (input.categoryIds.length > 0) {
        await tx.charityOnCategory.createMany({
          data: input.categoryIds.map((categoryId) => ({ charityId: id, categoryId })),
        })
      }
    }

    const hydrated = await loadHydrated(tx, id)
    if (hydrated === null) {
      throw new Error('updateCharity: row vanished mid-transaction')
    }
    return hydrated
  })

  await invalidateDonationEntity({
    redis: deps.redis,
    logger: deps.logger,
    entity: 'charity',
    id: row.charity.id,
  })
  deps.logger.info({ event: 'donation_charity_updated', entityId: row.charity.id, audit: true })

  return buildResponse(deps, row)
}
