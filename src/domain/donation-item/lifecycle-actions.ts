// Spec 020 §7 — unified lifecycle actions across Charity / DonationProject
// / SaleItem (and Category, which shares the same `archivedAt` / `deletedAt`
// columns).
//
// All four actions (archive / unarchive / delete / restore) follow the same
// idempotent-via-WHERE pattern (§7.3):
//
//   UPDATE <table> SET <stamp>=<value> WHERE id=? AND <stamp> <isOrIsNot> NULL
//
// rowcount === 0 means "already in the target state", so we skip the cache
// invalidate and return 200 no-op. Anything else (404 not found etc.) is the
// caller's job to handle by reading the row separately.
//
// We factor this out because the same 4-line implementation would otherwise
// repeat 4 × 3 = 12 times across the three entities (spec 020 §5.1.3-§5.1.6
// + §5.2 + §5.3). Less typo surface, one place to fix when concurrency
// semantics change.
//
// Why a generic factory and not 12 hand-rolled functions: the only thing
// that varies between Charity / Project / SaleItem is the Prisma delegate
// name (`prisma.charity` vs `prisma.donationProject` vs `prisma.saleItem`).
// We let the caller pass the delegate; TS infers the rest.

import type { FastifyBaseLogger } from 'fastify'

import {
  invalidateDonationEntity,
  type DonationEntity,
} from '../../lib/cache/invalidate-donation.js'
import type { Redis } from 'ioredis'

/**
 * The subset of a Prisma model delegate we need — just `updateMany`, which
 * returns `{ count: number }` and lets us combine a unique `where: { id }`
 * with a non-unique `where: { archivedAt: null }` predicate (`update()`
 * would reject the latter because it requires a unique key).
 */
interface LifecycleDelegate {
  updateMany: (args: {
    where: { id: string; archivedAt?: null | { not: null }; deletedAt?: null | { not: null } }
    data: { archivedAt?: Date | null; deletedAt?: Date | null }
  }) => Promise<{ count: number }>
}

export interface LifecycleActionDeps {
  redis: Redis
  logger: FastifyBaseLogger
  /** clock for stamping `archivedAt` / `deletedAt`. spec 020 §7 + spec 022 §4.0. */
  now: Date
}

export interface LifecycleActionContext {
  entity: DonationEntity
  /** Used in audit log payload + cache key cascading. */
  id: string
  /** Only relevant for `project` / `sale` — propagates to cache invalidator
   * so charity-scoped list slots get DEL'd. */
  parentCharityId?: string
  /** Pino event name to log on actual transition (skip on no-op). */
  auditEvent: string
}

export interface LifecycleActionResult {
  /** True if the row was actually transitioned this call; false on no-op. */
  changed: boolean
}

/**
 * Generic "set a single lifecycle stamp" action.
 *
 * `field` picks `archivedAt` vs `deletedAt`. `direction = 'set'` writes
 * `now` when the column is null; `'clear'` writes null when the column is
 * non-null. Anything else returns count=0 → no-op.
 */
async function applyLifecycleStamp(
  delegate: LifecycleDelegate,
  deps: LifecycleActionDeps,
  ctx: LifecycleActionContext,
  field: 'archivedAt' | 'deletedAt',
  direction: 'set' | 'clear',
): Promise<LifecycleActionResult> {
  const whereStamp = direction === 'set' ? null : { not: null }
  const stampValue: Date | null = direction === 'set' ? deps.now : null

  const updated = await delegate.updateMany({
    where: { id: ctx.id, [field]: whereStamp },
    data: { [field]: stampValue },
  })

  if (updated.count === 0) {
    return { changed: false }
  }

  await invalidateDonationEntity({
    redis: deps.redis,
    logger: deps.logger,
    entity: ctx.entity,
    id: ctx.id,
    parentCharityId: ctx.parentCharityId,
  })
  // spec 020 §12 — audit only on real transitions (no-op stays quiet).
  deps.logger.info({ event: ctx.auditEvent, entityId: ctx.id, audit: true })

  return { changed: true }
}

export function archive(
  delegate: LifecycleDelegate,
  deps: LifecycleActionDeps,
  ctx: LifecycleActionContext,
): Promise<LifecycleActionResult> {
  return applyLifecycleStamp(delegate, deps, ctx, 'archivedAt', 'set')
}

export function unarchive(
  delegate: LifecycleDelegate,
  deps: LifecycleActionDeps,
  ctx: LifecycleActionContext,
): Promise<LifecycleActionResult> {
  return applyLifecycleStamp(delegate, deps, ctx, 'archivedAt', 'clear')
}

export function softDelete(
  delegate: LifecycleDelegate,
  deps: LifecycleActionDeps,
  ctx: LifecycleActionContext,
): Promise<LifecycleActionResult> {
  return applyLifecycleStamp(delegate, deps, ctx, 'deletedAt', 'set')
}

export function restore(
  delegate: LifecycleDelegate,
  deps: LifecycleActionDeps,
  ctx: LifecycleActionContext,
): Promise<LifecycleActionResult> {
  return applyLifecycleStamp(delegate, deps, ctx, 'deletedAt', 'clear')
}

/**
 * Convenience: check existence of a row in a lifecycle-aware way without
 * tripping over Prisma's narrow `findUnique` typing. Used by route layer
 * before calling an action to differentiate 404 (row missing) from no-op
 * (row exists, already in target state) — spec 020 §4.3 contract.
 */
export async function exists(
  delegate: { findUnique: (args: { where: { id: string }; select: { id: true } }) => Promise<{ id: string } | null> },
  id: string,
): Promise<boolean> {
  return (await delegate.findUnique({ where: { id }, select: { id: true } })) !== null
}
