// Spec 021 §2.5 — barrel for the order domain module.
// Phase 1 (model) exports: invariants + next-charge-at calculation.
// Phase 2 / Phase 3 will add create-services / lifecycle-services / etc.

export { computeNextChargeAt } from './next-charge-at.js'
export {
  assertAmountConsistency,
  assertFrequencyBillingDayConsistency,
  assertLineCountWithinPhase1Limit,
  assertNextChargeAtConsistency,
  assertOrderInvariants,
  assertReceiptOptionConsistency,
  assertSubjectFkConsistency,
  InvariantError,
  type OrderLike,
  type OrderLineLike,
} from './validators.js'
