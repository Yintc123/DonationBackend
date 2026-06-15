// Spec 019 §6.2 — cache-aside adapter for sale-item endpoints.
//
// Detail:  key cache:sale:detail:v1:{id}:{locale},                      TTL 60s
// List:    key cache:sale:list:v1:{categoryOrAll}:{charityIdOrAll}:{locale}
//          TTL 30s. Whitelist: no cursor, default limit, no q, no charityId
//          (§4.2). Bypass otherwise.

import type { PrismaClient } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import type { Redis } from 'ioredis'

import { buildCacheKey, withCache } from '../lib/cache/index.js'
import type { Locale } from '../lib/i18n/index.js'
import {
  getSaleItemById,
  type DetailWithETag,
} from '../domain/donation-item/detail-services.js'
import {
  listSaleItems,
  type ListResult,
  type ProjectSaleListInput,
} from '../domain/donation-item/list-services.js'
import { DEFAULT_LIMIT } from '../domain/donation-item/list-helpers.js'
import type { SaleItemDetailT } from '../schemas/donation-item/detail.js'
import type { SaleItemListItemT } from '../schemas/donation-item/list-item.js'

const DETAIL_TTL_SEC = 60
const LIST_TTL_SEC = 30
const ALL_SENTINEL = 'ALL'

function isCacheableSaleItemList(input: ProjectSaleListInput): boolean {
  return (
    input.q === undefined &&
    input.cursor === undefined &&
    input.charityId === undefined &&
    (input.limit === undefined || input.limit === DEFAULT_LIMIT)
  )
}

type ObjectUrl = (key: string) => string

export interface CachedSaleItemDetailDeps {
  prisma: PrismaClient
  redis: Redis
  logger: FastifyBaseLogger
  now: Date
  locale: Locale
  objectUrl: ObjectUrl
  id: string
}

export async function getCachedSaleItemById(
  deps: CachedSaleItemDetailDeps,
): Promise<DetailWithETag<SaleItemDetailT>> {
  const key = buildCacheKey('sale:detail:v1', [deps.id, deps.locale])
  return withCache<DetailWithETag<SaleItemDetailT>>({
    redis: deps.redis,
    key,
    ttlSec: DETAIL_TTL_SEC,
    logger: deps.logger,
    loader: () =>
      getSaleItemById({
        prisma: deps.prisma,
        now: deps.now,
        locale: deps.locale,
        objectUrl: deps.objectUrl,
        id: deps.id,
      }),
  })
}

export interface CachedSaleItemListDeps {
  prisma: PrismaClient
  redis: Redis
  logger: FastifyBaseLogger
  now: Date
  locale: Locale
  objectUrl: ObjectUrl
  input: ProjectSaleListInput
}

export async function listCachedSaleItems(
  deps: CachedSaleItemListDeps,
): Promise<ListResult<SaleItemListItemT>> {
  const loader = (): Promise<ListResult<SaleItemListItemT>> =>
    listSaleItems({
      prisma: deps.prisma,
      now: deps.now,
      locale: deps.locale,
      objectUrl: deps.objectUrl,
      input: deps.input,
    })

  if (!isCacheableSaleItemList(deps.input)) {
    return loader()
  }

  const categorySeg = deps.input.category ?? ALL_SENTINEL
  const key = buildCacheKey('sale:list:v1', [categorySeg, ALL_SENTINEL, deps.locale])
  return withCache<ListResult<SaleItemListItemT>>({
    redis: deps.redis,
    key,
    ttlSec: LIST_TTL_SEC,
    logger: deps.logger,
    loader,
  })
}
