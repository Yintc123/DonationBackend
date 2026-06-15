// Spec 019 §6.2 — cache-aside adapter over listCategories.
//
// Wraps the pure domain service with cache concerns:
//   - Key:   cache:cat:list:v1:{locale}   (spec 019 §4.1)
//   - TTL:   600s                          (spec 019 §5.1 — dictionary近不可變)
//   - Value: { items, etag }               (spec 019 §7 — ETag co-stored so a
//                                            cache hit can still 304-short-circuit)

import type { PrismaClient } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import type { Redis } from 'ioredis'

import { buildCacheKey, withCache } from '../lib/cache/index.js'
import type { Locale } from '../lib/i18n/index.js'
import {
  listCategories,
  type CategoryListResult,
} from '../domain/category/list.js'

const CATEGORIES_TTL_SEC = 600

export interface CachedCategoryDeps {
  prisma: PrismaClient
  redis: Redis
  logger: FastifyBaseLogger
  locale: Locale
}

export async function listCachedCategories(
  deps: CachedCategoryDeps,
): Promise<CategoryListResult> {
  const key = buildCacheKey('cat:list:v1', [deps.locale])
  return withCache<CategoryListResult>({
    redis: deps.redis,
    key,
    ttlSec: CATEGORIES_TTL_SEC,
    logger: deps.logger,
    loader: () => listCategories({ prisma: deps.prisma, locale: deps.locale }),
  })
}
