// Spec 020 §8 / spec 019 §8.3 — donation domain cache invalidation.
//
// Each admin write (create / update / 4 lifecycle actions) on a Charity /
// DonationProject / SaleItem / Category enumerates the matching cache
// keys and DEL them via a single Redis pipeline. The set is finite by
// design (spec 019 §4.2 list whitelist = `categoryOrAll × charityOrAll ×
// locale`), so no SCAN — that's the spec 006 §4.3 hard ban.
//
// Failure mode (spec 019 §9.1): redis down → log warn, never throw. Cache
// will serve stale until TTL (≤ 60s for detail / 30s for list).
//
// Key shapes mirror `src/services/cached-*.ts` exactly:
//   cache:char:detail:v1:{id}:{locale}
//   cache:char:list:v1:{categoryOrAll}:{locale}
//   cache:proj:detail:v1:{id}:{locale}
//   cache:proj:list:v1:{categoryOrAll}:{charityIdOrAll}:{locale}
//   cache:sale:detail:v1:{id}:{locale}
//   cache:sale:list:v1:{categoryOrAll}:{charityIdOrAll}:{locale}
//   cache:cat:list:v1:{locale}
//
// Cascading rule (spec 020 §8.1):
//   - Charity write   → own detail + char list + proj list (charity-scoped)
//                                                + sale list (charity-scoped)
//   - Project write   → own detail + proj list
//   - SaleItem write  → own detail + sale list
//   - Category write  → cat list + (worst case) all char / proj / sale
//                       detail keys are SO MANY they're left to TTL —
//                       category renames happen rarely, the small staleness
//                       window is the price of avoiding SCAN.

import type { Redis } from 'ioredis'
import type { FastifyBaseLogger } from 'fastify'

import { CATEGORY_KEYS } from '../../domain/category/keys.js'

import { buildCacheKey } from './keys.js'

const LOCALES = ['zh-TW', 'en'] as const
const ALL_SENTINEL = 'ALL'

// One slot per (category OR all) — 17 entries.
const CATEGORY_LIST_SLOTS: readonly string[] = [ALL_SENTINEL, ...CATEGORY_KEYS]

export type DonationEntity = 'charity' | 'project' | 'sale' | 'category'

export interface InvalidateDonationContext {
  redis: Redis
  logger: FastifyBaseLogger
  entity: DonationEntity
  /** Entity row id. Used for the detail key + (project/sale) the
   * charityOrAll cascading slot. Pass an empty string for entity = 'category'. */
  id: string
  /** charityId of the parent charity (only required when `entity` is
   * 'project' or 'sale', so we know which charity-scoped list slot to
   * include in the cascading list invalidation). */
  parentCharityId?: string
}

/**
 * Build the full list of cache keys to DEL for one admin write.
 *
 * Pure function — separated out so `keysForCharity` etc. are unit-testable
 * without touching Redis (per backend CLAUDE.md "可 mock Redis" rule —
 * here we don't need to mock anything, just inspect the key list).
 */
export function donationCacheKeysFor(input: {
  entity: DonationEntity
  id: string
  parentCharityId?: string
}): readonly string[] {
  const out: string[] = []
  switch (input.entity) {
    case 'charity':
      // Detail for this charity in both locales.
      for (const loc of LOCALES) {
        out.push(buildCacheKey('char:detail:v1', [input.id, loc]))
      }
      // Charity list whitelist: every category × locale.
      for (const slot of CATEGORY_LIST_SLOTS) {
        for (const loc of LOCALES) {
          out.push(buildCacheKey('char:list:v1', [slot, loc]))
        }
      }
      // Cascading: project / sale list slots scoped to this charity (and
      // the ALL bucket which aggregates everyone).
      for (const charityScope of [input.id, ALL_SENTINEL]) {
        for (const slot of CATEGORY_LIST_SLOTS) {
          for (const loc of LOCALES) {
            out.push(buildCacheKey('proj:list:v1', [slot, charityScope, loc]))
            out.push(buildCacheKey('sale:list:v1', [slot, charityScope, loc]))
          }
        }
      }
      return out

    case 'project':
      for (const loc of LOCALES) {
        out.push(buildCacheKey('proj:detail:v1', [input.id, loc]))
      }
      // List invalidation scoped to (parentCharityId OR ALL) per category.
      // We always invalidate ALL too because public list cache key for "no
      // charityId filter" lives at the ALL slot.
      for (const charityScope of [input.parentCharityId, ALL_SENTINEL].filter(
        (s): s is string => typeof s === 'string',
      )) {
        for (const slot of CATEGORY_LIST_SLOTS) {
          for (const loc of LOCALES) {
            out.push(buildCacheKey('proj:list:v1', [slot, charityScope, loc]))
          }
        }
      }
      return out

    case 'sale':
      for (const loc of LOCALES) {
        out.push(buildCacheKey('sale:detail:v1', [input.id, loc]))
      }
      for (const charityScope of [input.parentCharityId, ALL_SENTINEL].filter(
        (s): s is string => typeof s === 'string',
      )) {
        for (const slot of CATEGORY_LIST_SLOTS) {
          for (const loc of LOCALES) {
            out.push(buildCacheKey('sale:list:v1', [slot, charityScope, loc]))
          }
        }
      }
      return out

    case 'category':
      // Spec 020 §8.1 + §14 OQ — Category PATCH (displayName / displayOrder)
      // technically influences EVERY hydrated charity / project / sale
      // detail key that inflates the category, but enumerating those would
      // mean walking three M:N relations under load. We accept the worst-
      // case staleness of one TTL (30-60s) because (a) category edits are
      // rare, (b) the cat:list invalidate below ensures the dictionary
      // dropdown itself is correct, (c) detail pages auto-refresh via
      // public-read TTL. Revisit if category-rename frequency rises.
      for (const loc of LOCALES) {
        out.push(buildCacheKey('cat:list:v1', [loc]))
      }
      return out
  }
}

export async function invalidateDonationEntity(
  ctx: InvalidateDonationContext,
): Promise<void> {
  const keys = donationCacheKeysFor({
    entity: ctx.entity,
    id: ctx.id,
    parentCharityId: ctx.parentCharityId,
  })
  if (keys.length === 0) return
  try {
    // ioredis pipeline = atomic-ish batched DEL; we don't need MULTI/EXEC
    // because each DEL is independently idempotent and out-of-order is fine.
    const pipeline = ctx.redis.pipeline()
    for (const k of keys) pipeline.del(k)
    await pipeline.exec()
  } catch (err) {
    ctx.logger.warn(
      { err, entity: ctx.entity, id: ctx.id, keyCount: keys.length, event: 'cache_invalidate_failed' },
      'donation cache invalidate failed; keys may serve stale until TTL',
    )
  }
}
