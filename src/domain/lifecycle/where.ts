// Backend ADR 006 — Entity lifecycle filter helpers.
//
// `whereLive(now)` is the canonical "this row is publicly visible right now"
// predicate. Every public list / detail endpoint that touches an entity with
// lifecycle fields (Charity / DonationProject / SaleItem) MUST go through it
// — route handlers may NOT hand-craft the four conditions. The grep target
// `whereLive` and `whereLiveWithParent` should turn up 100 % of public
// callers (ADR 006 §2 / §3).
//
// `whereLiveWithParent(now)` extends `whereLive` with the cascading
// visibility rule: a DonationProject / SaleItem is only public when its own
// row passes AND the owning Charity passes the same predicate. This is how
// Charity cooperation-contract expiry (publishEndAt) propagates to all
// children without any batch job (ADR 006 §3 / spec 015 §3.3).
//
// Implementation notes:
//   - We return plain literals, not Prisma.XxxWhereInput, so the same helper
//     applies structurally to all three entity types (they share the same
//     five lifecycle columns). Call sites spread the result into the
//     entity-specific `where` and TypeScript duck-types it.
//   - Prisma's `where` cannot conjoin two `OR` keys at the top level; the
//     canonical workaround is `AND: [{ OR: [...] }, { OR: [...] }]`.
//   - Each call returns a fresh object — no shared references — so caller
//     mutation cannot leak across the application.

/**
 * The four-condition predicate. Use on Charity, DonationProject, SaleItem.
 *
 * We deliberately return a mutable plain object (no `as const`) so the
 * literal structurally satisfies Prisma's `CharityWhereInput.AND` /
 * `DonationProjectWhereInput.AND` / `SaleItemWhereInput.AND` — those types
 * are typed as mutable arrays and reject `readonly` tuples.
 */
export function whereLive(now: Date) {
  return {
    deletedAt: null,
    archivedAt: null,
    AND: [
      { OR: [{ publishStartAt: null }, { publishStartAt: { lte: now } }] },
      { OR: [{ publishEndAt: null }, { publishEndAt: { gt: now } }] },
    ],
  }
}

/**
 * Cascading visibility: child row is live AND owning Charity is live.
 * Use on DonationProject and SaleItem list / detail public queries
 * (ADR 006 §3).
 */
export function whereLiveWithParent(now: Date) {
  return {
    ...whereLive(now),
    charity: { is: whereLive(now) },
  }
}

/**
 * Spec 026 §2.3 / spec 015 §3.3 v0.9 — admin-side lifecycle filter.
 *
 * Default (`{ includeArchived: false, includeDeleted: false }`) returns the
 * "in-progress" row set (`archivedAt IS NULL AND deletedAt IS NULL`) —
 * exactly the public liveness set minus the publish-window predicates.
 *
 * `publishStartAt` / `publishEndAt` are deliberately NOT applied: the
 * publish window is a scheduling mechanism, not a lifecycle state, and
 * admins must be able to list / edit rows that are scheduled for the
 * future or that have already come down.
 *
 * Toggling either flag drops the corresponding predicate; toggling both
 * returns `{}` (the full table). Cascading visibility is intentionally NOT
 * applied — admins inspecting an archived charity's still-active project
 * is a legitimate workflow (parent state is signalled separately via the
 * `parentCharity*At` hints on the admin Project / SaleItem detail shape).
 *
 * Returns a fresh literal — mutating the result does not leak across
 * callers.
 */
export interface AdminLifecycleFilter {
  includeArchived: boolean
  includeDeleted: boolean
}

export function whereForAdmin(opts: AdminLifecycleFilter) {
  const where: { archivedAt?: null; deletedAt?: null } = {}
  if (!opts.includeArchived) where.archivedAt = null
  if (!opts.includeDeleted) where.deletedAt = null
  return where
}
