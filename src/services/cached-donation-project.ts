// Spec 019 §6.2 — cache-aside adapter for donation-project endpoints.
//
// Detail:  key cache:proj:detail:v1:{id}:{locale},                      TTL 60s
// List:    key cache:proj:list:v1:{categoryOrAll}:{charityIdOrAll}:{locale}
//          TTL 30s. Whitelist: no cursor, default limit, no q, no charityId
//          (§4.2). Bypass otherwise.

import type { PrismaClient } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import type { Redis } from 'ioredis'

import { buildCacheKey, withCache } from '../lib/cache/index.js'
import type { Locale } from '../lib/i18n/index.js'
import {
  getDonationProjectById,
  type DetailWithETag,
} from '../domain/donation-item/detail-services.js'
import {
  listDonationProjects,
  type ListResult,
  type ProjectSaleListInput,
} from '../domain/donation-item/list-services.js'
import { DEFAULT_LIMIT } from '../domain/donation-item/list-helpers.js'
import type { ProjectDetailT } from '../schemas/donation-item/detail.js'
import type { ProjectListItemT } from '../schemas/donation-item/list-item.js'

const DETAIL_TTL_SEC = 60
const LIST_TTL_SEC = 30
const ALL_SENTINEL = 'ALL'

function isCacheableProjectList(input: ProjectSaleListInput): boolean {
  return (
    input.q === undefined &&
    input.cursor === undefined &&
    input.charityId === undefined &&
    (input.limit === undefined || input.limit === DEFAULT_LIMIT)
  )
}

type ObjectUrl = (key: string) => string

export interface CachedDonationProjectDetailDeps {
  prisma: PrismaClient
  redis: Redis
  logger: FastifyBaseLogger
  now: Date
  locale: Locale
  objectUrl: ObjectUrl
  id: string
}

export async function getCachedDonationProjectById(
  deps: CachedDonationProjectDetailDeps,
): Promise<DetailWithETag<ProjectDetailT>> {
  const key = buildCacheKey('proj:detail:v1', [deps.id, deps.locale])
  return withCache<DetailWithETag<ProjectDetailT>>({
    redis: deps.redis,
    key,
    ttlSec: DETAIL_TTL_SEC,
    logger: deps.logger,
    loader: () =>
      getDonationProjectById({
        prisma: deps.prisma,
        now: deps.now,
        locale: deps.locale,
        objectUrl: deps.objectUrl,
        id: deps.id,
      }),
  })
}

export interface CachedDonationProjectListDeps {
  prisma: PrismaClient
  redis: Redis
  logger: FastifyBaseLogger
  now: Date
  locale: Locale
  objectUrl: ObjectUrl
  input: ProjectSaleListInput
}

export async function listCachedDonationProjects(
  deps: CachedDonationProjectListDeps,
): Promise<ListResult<ProjectListItemT>> {
  const loader = (): Promise<ListResult<ProjectListItemT>> =>
    listDonationProjects({
      prisma: deps.prisma,
      now: deps.now,
      locale: deps.locale,
      objectUrl: deps.objectUrl,
      input: deps.input,
    })

  if (!isCacheableProjectList(deps.input)) {
    return loader()
  }

  const categorySeg = deps.input.category ?? ALL_SENTINEL
  const key = buildCacheKey('proj:list:v1', [categorySeg, ALL_SENTINEL, deps.locale])
  return withCache<ListResult<ProjectListItemT>>({
    redis: deps.redis,
    key,
    ttlSec: LIST_TTL_SEC,
    logger: deps.logger,
    loader,
  })
}
