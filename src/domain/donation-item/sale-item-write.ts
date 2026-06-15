// Spec 020 §5.3 — SaleItem admin write services.
// Structurally identical to project-write.ts plus a required `priceTwd`.

import type { SaleItem, Prisma, PrismaClient } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import type { Redis } from 'ioredis'

import { BadRequestError, ErrorCode, NotFoundError } from '../../lib/errors/index.js'
import { invalidateDonationEntity } from '../../lib/cache/invalidate-donation.js'
import { assertS3KeyBinding, assertValidObjectKey } from '../../lib/s3/index.js'
import { type Locale, pickLocalised } from '../../lib/i18n/index.js'

import type { SaleItemDetailT } from '../../schemas/donation-item/detail.js'

type ObjectUrl = (key: string) => string

export interface SaleItemWriteDeps {
  prisma: PrismaClient
  redis: Redis
  logger: FastifyBaseLogger
  locale: Locale
  objectUrl: ObjectUrl
}

export interface SaleItemCreateInput {
  charityId: string
  name: string
  description: string
  content: string
  priceTwd: number
  nameEn?: string | null
  descriptionEn?: string | null
  contentEn?: string | null
  logoKey?: string | null
  coverImageKey?: string | null
  raisingApprovalNo?: string | null
  reliefApprovalNo?: string | null
  displayOrder?: number
  publishStartAt?: string | null
  publishEndAt?: string | null
}

export interface SaleItemPatchInput {
  name?: string
  description?: string
  content?: string
  priceTwd?: number
  nameEn?: string | null
  descriptionEn?: string | null
  contentEn?: string | null
  logoKey?: string | null
  coverImageKey?: string | null
  raisingApprovalNo?: string | null
  reliefApprovalNo?: string | null
  displayOrder?: number
  publishStartAt?: string | null
  publishEndAt?: string | null
}

function assertPublishRange(start: string | null | undefined, end: string | null | undefined): void {
  if (start == null || end == null) return
  if (new Date(start) >= new Date(end)) {
    throw new BadRequestError({
      code: ErrorCode.INVALID_LIFECYCLE_RANGE,
      message: 'publishStartAt must be strictly before publishEndAt',
    })
  }
}

function assertImageKeys(
  input: { logoKey?: string | null; coverImageKey?: string | null },
  expectedId?: string,
): void {
  if (input.logoKey != null) {
    assertValidObjectKey(input.logoKey, '/logoKey')
    assertS3KeyBinding(input.logoKey, 'sale-items', '/logoKey', expectedId)
  }
  if (input.coverImageKey != null) {
    assertValidObjectKey(input.coverImageKey, '/coverImageKey')
    assertS3KeyBinding(input.coverImageKey, 'sale-items', '/coverImageKey', expectedId)
  }
}

async function assertParentCharityExists(
  prisma: Prisma.TransactionClient | PrismaClient,
  charityId: string,
): Promise<void> {
  const parent = await prisma.charity.findUnique({
    where: { id: charityId },
    select: { id: true },
  })
  if (parent === null) {
    throw new NotFoundError({
      resource: 'charity',
      id: charityId,
      code: ErrorCode.CHARITY_NOT_FOUND,
    })
  }
}

function parseDate(iso: string | null | undefined): Date | null | undefined {
  if (iso === undefined) return undefined
  if (iso === null) return null
  return new Date(iso)
}

interface HydratedSaleItemRow {
  saleItem: SaleItem & {
    charity: {
      id: string
      name: string
      nameEn: string | null
      logoKey: string | null
      categories: {
        category: { id: string; key: string; displayName: string; displayNameEn: string | null }
      }[]
    }
  }
}

function buildResponse(deps: SaleItemWriteDeps, row: HydratedSaleItemRow): SaleItemDetailT {
  const s = row.saleItem
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
    categories: s.charity.categories.map((cc) => ({
      id: cc.category.id,
      key: cc.category.key,
      displayName: pickLocalised(deps.locale, {
        zh: cc.category.displayName,
        en: cc.category.displayNameEn,
      }),
    })),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }
}

async function loadHydrated(
  prisma: Prisma.TransactionClient | PrismaClient,
  id: string,
): Promise<HydratedSaleItemRow | null> {
  const row = await prisma.saleItem.findUnique({
    where: { id },
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
  if (row === null) return null
  return { saleItem: row }
}

export async function createSaleItem(
  deps: SaleItemWriteDeps,
  input: SaleItemCreateInput,
): Promise<SaleItemDetailT> {
  assertPublishRange(input.publishStartAt, input.publishEndAt)
  assertImageKeys(input)
  await assertParentCharityExists(deps.prisma, input.charityId)

  const created = await deps.prisma.saleItem.create({
    data: {
      charityId: input.charityId,
      name: input.name,
      description: input.description,
      content: input.content,
      priceTwd: input.priceTwd,
      nameEn: input.nameEn ?? null,
      descriptionEn: input.descriptionEn ?? null,
      contentEn: input.contentEn ?? null,
      logoKey: input.logoKey ?? null,
      coverImageKey: input.coverImageKey ?? null,
      raisingApprovalNo: input.raisingApprovalNo ?? null,
      reliefApprovalNo: input.reliefApprovalNo ?? null,
      displayOrder: input.displayOrder ?? 0,
      publishStartAt: parseDate(input.publishStartAt) ?? undefined,
      publishEndAt: parseDate(input.publishEndAt) ?? undefined,
    },
  })

  const hydrated = await loadHydrated(deps.prisma, created.id)
  if (hydrated === null) {
    throw new Error('createSaleItem: row vanished immediately after create')
  }

  await invalidateDonationEntity({
    redis: deps.redis,
    logger: deps.logger,
    entity: 'sale',
    id: hydrated.saleItem.id,
    parentCharityId: hydrated.saleItem.charityId,
  })
  deps.logger.info({
    event: 'donation_sale_created',
    entityId: hydrated.saleItem.id,
    audit: true,
  })

  return buildResponse(deps, hydrated)
}

export async function updateSaleItem(
  deps: SaleItemWriteDeps,
  id: string,
  input: SaleItemPatchInput,
): Promise<SaleItemDetailT> {
  assertPublishRange(input.publishStartAt, input.publishEndAt)
  // PATCH knows the row id — bind keys to this exact row (spec 020 §10).
  assertImageKeys(input, id)

  const existing = await deps.prisma.saleItem.findUnique({
    where: { id },
    select: { id: true, charityId: true },
  })
  if (existing === null) {
    throw new NotFoundError({
      resource: 'sale-item',
      id,
      code: ErrorCode.SALE_ITEM_NOT_FOUND,
    })
  }

  await deps.prisma.saleItem.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description,
      content: input.content,
      priceTwd: input.priceTwd,
      nameEn: input.nameEn,
      descriptionEn: input.descriptionEn,
      contentEn: input.contentEn,
      logoKey: input.logoKey,
      coverImageKey: input.coverImageKey,
      raisingApprovalNo: input.raisingApprovalNo,
      reliefApprovalNo: input.reliefApprovalNo,
      displayOrder: input.displayOrder,
      publishStartAt: parseDate(input.publishStartAt),
      publishEndAt: parseDate(input.publishEndAt),
    },
  })

  const hydrated = await loadHydrated(deps.prisma, id)
  if (hydrated === null) {
    throw new Error('updateSaleItem: row vanished post-update')
  }

  await invalidateDonationEntity({
    redis: deps.redis,
    logger: deps.logger,
    entity: 'sale',
    id: hydrated.saleItem.id,
    parentCharityId: hydrated.saleItem.charityId,
  })
  deps.logger.info({
    event: 'donation_sale_updated',
    entityId: hydrated.saleItem.id,
    audit: true,
  })

  return buildResponse(deps, hydrated)
}
