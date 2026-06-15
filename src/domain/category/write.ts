// Spec 020 §5.4 — Category admin write service.
//
// Only PATCH and lifecycle actions exist; no create (key is a TypeScript
// const, see ./keys.ts — runtime key creation breaks the public read
// filter validator). Hard delete is also forbidden by the spec 015 §3.4
// onDelete: Restrict — admins use soft delete (POST /:id/archive or
// DELETE /:id) plus the public read endpoints' `where: { category:
// { deletedAt: null, archivedAt: null } }` to make the row invisible.

import type { PrismaClient } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import type { Redis } from 'ioredis'

import { invalidateDonationEntity } from '../../lib/cache/invalidate-donation.js'
import { ErrorCode, NotFoundError } from '../../lib/errors/index.js'
import { type Locale, pickLocalised } from '../../lib/i18n/index.js'

import type { CategoryAdminResponseT } from '../../schemas/category/admin.js'

export interface CategoryWriteDeps {
  prisma: PrismaClient
  redis: Redis
  logger: FastifyBaseLogger
  locale: Locale
}

export interface CategoryPatchInput {
  displayName?: string
  displayNameEn?: string | null
  displayOrder?: number
}

function buildResponse(deps: CategoryWriteDeps, row: {
  id: string
  key: string
  displayName: string
  displayNameEn: string | null
  displayOrder: number
}): CategoryAdminResponseT {
  return {
    id: row.id,
    key: row.key,
    displayName: pickLocalised(deps.locale, { zh: row.displayName, en: row.displayNameEn }),
    displayOrder: row.displayOrder,
  }
}

export async function updateCategory(
  deps: CategoryWriteDeps,
  id: string,
  input: CategoryPatchInput,
): Promise<CategoryAdminResponseT> {
  const existing = await deps.prisma.category.findUnique({ where: { id }, select: { id: true } })
  if (existing === null) {
    throw new NotFoundError({ resource: 'category', id, code: ErrorCode.CATEGORY_NOT_FOUND })
  }

  const updated = await deps.prisma.category.update({
    where: { id },
    data: {
      displayName: input.displayName,
      displayNameEn: input.displayNameEn,
      displayOrder: input.displayOrder,
    },
    select: {
      id: true,
      key: true,
      displayName: true,
      displayNameEn: true,
      displayOrder: true,
    },
  })

  await invalidateDonationEntity({
    redis: deps.redis,
    logger: deps.logger,
    entity: 'category',
    id,
  })
  deps.logger.info({ event: 'donation_category_updated', entityId: id, audit: true })

  return buildResponse(deps, updated)
}
