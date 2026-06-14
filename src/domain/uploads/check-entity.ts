// Spec 018 §7.4.1 — "does this entity row exist?" for the presign endpoint.
//
// Without this check, the presign endpoint would issue signed PUT URLs for
// keys that no DB row will ever reference — orphan objects in S3.
//
// Implementation note (2026-06-14): The donation entities
// (Charity, DonationProject, SaleItem) are specified in spec 015 but the
// Prisma migrations have not landed yet. Until they do, we treat every id
// as "not found" rather than silently signing URLs for non-existent rows.
// When spec 015 ships, switch the cases below to call the real Prisma
// delegates per spec 018 §7.4.1 — the call site does not change.

import type { PrismaClient } from '@prisma/client'

import { ErrorCode, NotFoundError } from '../../lib/errors/index.js'
import type { UploadEntity } from '../../lib/s3/index.js'

const ENTITY_NOT_FOUND_CODE: Record<UploadEntity, string> = {
  charities: ErrorCode.CHARITY_NOT_FOUND,
  'donation-projects': ErrorCode.DONATION_PROJECT_NOT_FOUND,
  'sale-items': ErrorCode.SALE_ITEM_NOT_FOUND,
}

const ENTITY_RESOURCE_LABEL: Record<UploadEntity, string> = {
  charities: 'charity',
  'donation-projects': 'donation-project',
  'sale-items': 'sale-item',
}

/**
 * Looks up the entity row by id.
 *
 * Returns successfully when the row exists; throws {@link NotFoundError}
 * with the spec-defined code otherwise.
 */
export async function ensureEntityExists(
  prisma: PrismaClient,
  entity: UploadEntity,
  id: string,
): Promise<void> {
  const exists = await lookupEntity(prisma, entity, id)
  if (!exists) {
    throw new NotFoundError({
      resource: ENTITY_RESOURCE_LABEL[entity],
      id,
      code: ENTITY_NOT_FOUND_CODE[entity],
    })
  }
}

interface FindUniqueDelegate {
  findUnique(args: {
    where: { id: string }
    select: { id: true }
  }): Promise<{ id: string } | null>
}

function getDelegate(
  prisma: PrismaClient,
  modelName: string,
): FindUniqueDelegate | undefined {
  // The donation delegates (`charity`, `donationProject`, `saleItem`) are not
  // generated until spec 015 lands. Until then, the property is `undefined`
  // and the call should treat every lookup as 404.
  const delegate = (prisma as unknown as Record<string, unknown>)[modelName]
  if (delegate === undefined || delegate === null) return undefined
  return delegate as FindUniqueDelegate
}

async function lookupEntity(
  prisma: PrismaClient,
  entity: UploadEntity,
  id: string,
): Promise<boolean> {
  const modelName = entityToModelName(entity)
  const delegate = getDelegate(prisma, modelName)
  if (!delegate) return false
  const row = await delegate.findUnique({ where: { id }, select: { id: true } })
  return row !== null
}

function entityToModelName(entity: UploadEntity): string {
  switch (entity) {
    case 'charities':
      return 'charity'
    case 'donation-projects':
      return 'donationProject'
    case 'sale-items':
      return 'saleItem'
  }
}
