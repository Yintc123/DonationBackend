// Spec 021 §7.1-§7.6 — Order domain invariant assertions.
//
// These guards run at the boundary between application logic and the
// database — every create-service (Phase 2) calls `assertOrderInvariants`
// inside the transaction, just before commit. By the time we get here:
//
//   - the route layer has already accepted the body (TypeBox passed),
//   - the service has already converted user-facing failures to 400s
//     (INVALID_BILLING_DAY etc., spec 022 §5.2),
//   - everything we still catch is therefore a *code* bug, not user error.
//
// Hence the loud-and-internal 500: `InvariantError` extends `AppError`
// with `expose: false`, so the wire-format stays opaque ("Internal Server
// Error") while the log captures the rule name + the failing field.
// pino's err serializer walks `cause`, so a future caller can chain
// causes if useful.
//
// We deliberately accept structural `OrderLike` / `OrderLineLike` types
// rather than `@prisma/client`'s `Order` / `OrderLine` — the assertions
// run on freshly-constructed line objects (pre-create transaction), not
// on round-tripped Prisma rows. The Prisma types extend our shape
// structurally, so the same call site works for both.

import type { DonationFrequency, BillingDay, OrderSubjectType, ReceiptOption } from '@prisma/client'

import { AppError } from '../../lib/errors/AppError.js'

// ── Error class ────────────────────────────────────────────────────────────

export class InvariantError extends AppError {
  constructor(message: string) {
    super({
      message,
      statusCode: 500,
      code: 'INVARIANT_VIOLATED',
    })
  }
}

function fail(rule: string, detail: string): never {
  throw new InvariantError(`Order invariant violated [${rule}]: ${detail}`)
}

// ── Structural input types ─────────────────────────────────────────────────

export interface OrderLineLike {
  subjectType: OrderSubjectType
  charityId: string | null
  donationProjectId: string | null
  saleItemId: string | null
  quantity: number
  unitPriceTwd: number
  subtotalTwd: number
  donationFrequency: DonationFrequency | null
  billingDay: BillingDay | null
}

export interface OrderLike {
  amountTwd: number
  receiptOption: ReceiptOption | null
  nextChargeAt: Date | null
  lines: OrderLineLike[]
}

// ── §7.1 subjectType ↔ polymorphic FK consistency ──────────────────────────

const DONATION_SUBJECTS: ReadonlySet<OrderSubjectType> = new Set(['CHARITY', 'DONATION_PROJECT'])

export function assertSubjectFkConsistency(line: OrderLineLike): void {
  switch (line.subjectType) {
    case 'CHARITY':
      if (line.charityId === null) fail('§7.1', 'CHARITY line must set charityId')
      if (line.donationProjectId !== null) fail('§7.1', 'CHARITY line must leave donationProjectId null')
      if (line.saleItemId !== null) fail('§7.1', 'CHARITY line must leave saleItemId null')
      return
    case 'DONATION_PROJECT':
      if (line.donationProjectId === null) fail('§7.1', 'DONATION_PROJECT line must set donationProjectId')
      if (line.charityId !== null) fail('§7.1', 'DONATION_PROJECT line must leave charityId null')
      if (line.saleItemId !== null) fail('§7.1', 'DONATION_PROJECT line must leave saleItemId null')
      return
    case 'SALE_ITEM':
      if (line.saleItemId === null) fail('§7.1', 'SALE_ITEM line must set saleItemId')
      if (line.charityId !== null) fail('§7.1', 'SALE_ITEM line must leave charityId null')
      if (line.donationProjectId !== null) fail('§7.1', 'SALE_ITEM line must leave donationProjectId null')
      return
  }
}

// ── §7.2 frequency ↔ billingDay (donation-only) ────────────────────────────

export function assertFrequencyBillingDayConsistency(line: OrderLineLike): void {
  const isDonation = DONATION_SUBJECTS.has(line.subjectType)
  if (isDonation) {
    if (line.donationFrequency === null) fail('§7.2', 'donation line must set donationFrequency')
    if (line.donationFrequency === 'RECURRING' && line.billingDay === null) {
      fail('§7.2', 'RECURRING donation must set billingDay')
    }
    if (line.donationFrequency === 'ONE_TIME' && line.billingDay !== null) {
      fail('§7.2', 'ONE_TIME donation must leave billingDay null')
    }
    return
  }
  // SALE_ITEM
  if (line.donationFrequency !== null) fail('§7.2', 'SALE_ITEM line must leave donationFrequency null')
  if (line.billingDay !== null) fail('§7.2', 'SALE_ITEM line must leave billingDay null')
}

// ── §7.3 amount arithmetic + quantity bounds ───────────────────────────────

const QUANTITY_MIN = 1
const QUANTITY_MAX = 100

export function assertAmountConsistency(order: OrderLike): void {
  let sum = 0
  for (const line of order.lines) {
    if (line.quantity < QUANTITY_MIN || line.quantity > QUANTITY_MAX) {
      fail('§7.3', `quantity ${line.quantity} out of [${QUANTITY_MIN}, ${QUANTITY_MAX}]`)
    }
    const expected = line.quantity * line.unitPriceTwd
    if (line.subtotalTwd !== expected) {
      fail('§7.3', `subtotalTwd ${line.subtotalTwd} ≠ quantity × unitPriceTwd (${expected})`)
    }
    sum += line.subtotalTwd
  }
  if (order.amountTwd !== sum) {
    fail('§7.3', `Order.amountTwd ${order.amountTwd} ≠ sum of subtotals (${sum})`)
  }
}

// ── §7.4 line count phase-1 limit ──────────────────────────────────────────
//
// Lifted to a constant so the future "open cart" change is one symbol grep
// rather than chasing magic numbers.
const PHASE1_MAX_LINES = 1

export function assertLineCountWithinPhase1Limit(order: OrderLike): void {
  if (order.lines.length !== PHASE1_MAX_LINES) {
    fail('§7.4', `lines.length must be exactly ${PHASE1_MAX_LINES} in phase 1 (got ${order.lines.length})`)
  }
}

// ── §7.5 receiptOption ↔ subjectType ───────────────────────────────────────

export function assertReceiptOptionConsistency(order: OrderLike): void {
  // Phase 1 invariant guarantees a single line; we read subjectType from it.
  // (When cart is opened we'll need to revisit — spec 021 §10 OQ #10.)
  const first = order.lines[0]
  if (first === undefined) return // delegated to §7.4
  if (first.subjectType === 'SALE_ITEM') {
    if (order.receiptOption !== null) {
      fail('§7.5', 'SALE_ITEM order must leave receiptOption null (IMG_4890 has no dropdown)')
    }
    return
  }
  if (order.receiptOption === null) {
    fail('§7.5', 'CHARITY / DONATION_PROJECT order must set receiptOption')
  }
}

// ── §7.6 nextChargeAt ↔ donationFrequency ──────────────────────────────────

export function assertNextChargeAtConsistency(order: OrderLike): void {
  const first = order.lines[0]
  if (first === undefined) return
  const isRecurring = first.donationFrequency === 'RECURRING'
  if (isRecurring) {
    if (order.nextChargeAt === null) {
      fail('§7.6', 'RECURRING order must set nextChargeAt')
    }
    return
  }
  if (order.nextChargeAt !== null) {
    fail('§7.6', 'ONE_TIME / SALE_ITEM order must leave nextChargeAt null')
  }
}

// ── Aggregate ──────────────────────────────────────────────────────────────

export function assertOrderInvariants(order: OrderLike): void {
  // Cardinality first — every other rule reads `order.lines[0]`.
  assertLineCountWithinPhase1Limit(order)
  for (const line of order.lines) {
    assertSubjectFkConsistency(line)
    assertFrequencyBillingDayConsistency(line)
  }
  assertAmountConsistency(order)
  assertReceiptOptionConsistency(order)
  assertNextChargeAtConsistency(order)
}
