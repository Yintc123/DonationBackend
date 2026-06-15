// Spec 021 §7.7 — next-charge-at calculation for RECURRING donations.
//
// Returns the first future date at which a RECURRING subscription should
// be debited, materialised as a midnight-UTC timestamp:
//
//   computeNextChargeAt(now, billingDay)
//     -> Date at 00:00:00.000 UTC, on `billingDay` (6, 16, 26),
//        in either `now`'s month (if billingDay is still ahead this month)
//        or the following month (if today's date is on or past billingDay).
//
// The "same day = already past" rule (strict `<`) is intentional: by the
// time an order is created at 09:00 on the 16th the cron has already
// missed today's window, so the next eligible charge must be next month.
//
// This function is pure and time-zone-agnostic at the input side — it
// reads UTC fields from `now`. Callers MUST pass an injected clock
// result (`deps.clock()`), never `new Date()` (spec 021 §7.7 / spec 022
// §4.0 Clock convention).
//
// Edge cases:
//   - All billingDays (6, 16, 26) exist in every month (no Feb-30 risk).
//     If we ever add DAY_31, callers will need to special-case Feb / 30-day
//     months — out of scope for v0.7.
//   - The Date constructor handles month-wraparound automatically
//     (month=12 → Jan of next year), so December cases roll the year
//     forward without special-casing.

import type { BillingDay } from '@prisma/client'

const BILLING_DAY_TO_DOM: Record<BillingDay, number> = {
  DAY_6: 6,
  DAY_16: 16,
  DAY_26: 26,
}

export function computeNextChargeAt(now: Date, billingDay: BillingDay): Date {
  const targetDom = BILLING_DAY_TO_DOM[billingDay]
  const todayDom = now.getUTCDate()
  const monthOffset = todayDom < targetDom ? 0 : 1

  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, targetDom, 0, 0, 0, 0),
  )
}
