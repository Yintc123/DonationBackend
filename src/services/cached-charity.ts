// Spec 019 §6.2 — cache-aside adapter for charity endpoints.
//
// Detail:  key cache:char:detail:v1:{id}:{locale},               TTL 60s
// List:    key cache:char:list:v1:{categoryOrAll}:{locale},      TTL 30s
//          ONLY caches the §4.2 hot whitelist: no cursor, default limit,
//          no q, no charityId. Anything else bypasses cache (§3.3 — key
//          explosion vs hit-rate trade-off).
//
// NotFoundError from the detail loader propagates unchanged — spec 019 §7.4
// 禁 negative cache.

import type { PrismaClient } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import type { Redis } from 'ioredis'

import { buildCacheKey, withCache } from '../lib/cache/index.js'
import type { Locale } from '../lib/i18n/index.js'
import {
  getCharityById,
  type DetailWithETag,
} from '../domain/donation-item/detail-services.js'
import {
  listCharities,
  type ListInput,
  type ListResult,
} from '../domain/donation-item/list-services.js'
import { DEFAULT_LIMIT } from '../domain/donation-item/list-helpers.js'
import type { CharityDetailT } from '../schemas/donation-item/detail.js'
import type { CharityListItemT } from '../schemas/donation-item/list-item.js'

const DETAIL_TTL_SEC = 60
const LIST_TTL_SEC = 30
const ALL_SENTINEL = 'ALL'

/** Spec 019 §4.2 — hot-whitelist gate for the charity list cache. */
function isCacheableCharityList(input: ListInput): boolean {
  return (
    input.q === undefined &&
    input.cursor === undefined &&
    (input.limit === undefined || input.limit === DEFAULT_LIMIT)
  )
}

type ObjectUrl = (key: string) => string

export interface CachedCharityDetailDeps {
  prisma: PrismaClient
  redis: Redis
  logger: FastifyBaseLogger
  now: Date
  locale: Locale
  objectUrl: ObjectUrl
  id: string
}

export async function getCachedCharityById(
  deps: CachedCharityDetailDeps,
): Promise<DetailWithETag<CharityDetailT>> {
  const key = buildCacheKey('char:detail:v1', [deps.id, deps.locale])
  return withCache<DetailWithETag<CharityDetailT>>({
    redis: deps.redis,
    key,
    ttlSec: DETAIL_TTL_SEC,
    logger: deps.logger,
    loader: () =>
      getCharityById({
        prisma: deps.prisma,
        now: deps.now,
        locale: deps.locale,
        objectUrl: deps.objectUrl,
        id: deps.id,
      }),
  })
}

export interface CachedCharityListDeps {
  prisma: PrismaClient
  redis: Redis
  logger: FastifyBaseLogger
  now: Date
  locale: Locale
  objectUrl: ObjectUrl
  input: ListInput
}

export async function listCachedCharities(
  deps: CachedCharityListDeps,
): Promise<ListResult<CharityListItemT>> {
  const loader = (): Promise<ListResult<CharityListItemT>> =>
    listCharities({
      prisma: deps.prisma,
      now: deps.now,
      locale: deps.locale,
      objectUrl: deps.objectUrl,
      input: deps.input,
    })

  if (!isCacheableCharityList(deps.input)) {
    return loader() // bypass — spec 019 §3.3
  }

  const categorySeg = deps.input.category ?? ALL_SENTINEL
  const key = buildCacheKey('char:list:v1', [categorySeg, deps.locale])
  return withCache<ListResult<CharityListItemT>>({
    redis: deps.redis,
    key,
    ttlSec: LIST_TTL_SEC,
    logger: deps.logger,
    loader,
  })
}
