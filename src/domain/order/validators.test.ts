// Spec 021 §7.1-§7.6 — Order domain invariant assertions.
//
// These guards run inside the create-service transaction (Phase 2) right
// before the row hits Postgres. Anything they catch is a code bug — the
// route layer / TypeBox should already have rejected user-facing shapes
// (400 INVALID_BILLING_DAY etc., spec 022 §5.2). When they fire we want a
// loud 500 so it surfaces in logs / alerting, never a quiet half-write.
//
// We test each rule in isolation plus the aggregate `assertOrderInvariants`
// so a regression that wires the assertions in the wrong order can't pass.

import { describe, expect, it } from 'vitest'

import { AppError } from '../../lib/errors/AppError.js'
import {
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

// ── Test fixtures ──────────────────────────────────────────────────────────

const charityLine = (over: Partial<OrderLineLike> = {}): OrderLineLike => ({
  subjectType: 'CHARITY',
  charityId: 'c-1',
  donationProjectId: null,
  saleItemId: null,
  quantity: 1,
  unitPriceTwd: 500,
  subtotalTwd: 500,
  donationFrequency: 'ONE_TIME',
  billingDay: null,
  ...over,
})

const projectLine = (over: Partial<OrderLineLike> = {}): OrderLineLike => ({
  subjectType: 'DONATION_PROJECT',
  charityId: null,
  donationProjectId: 'p-1',
  saleItemId: null,
  quantity: 1,
  unitPriceTwd: 500,
  subtotalTwd: 500,
  donationFrequency: 'RECURRING',
  billingDay: 'DAY_16',
  ...over,
})

const saleLine = (over: Partial<OrderLineLike> = {}): OrderLineLike => ({
  subjectType: 'SALE_ITEM',
  charityId: null,
  donationProjectId: null,
  saleItemId: 's-1',
  quantity: 2,
  unitPriceTwd: 449,
  subtotalTwd: 898,
  donationFrequency: null,
  billingDay: null,
  ...over,
})

const order = (lines: OrderLineLike[], over: Partial<OrderLike> = {}): OrderLike => ({
  amountTwd: lines.reduce((acc, l) => acc + l.subtotalTwd, 0),
  receiptOption: lines[0]?.subjectType === 'SALE_ITEM' ? null : 'NONE',
  nextChargeAt: lines[0]?.donationFrequency === 'RECURRING'
    ? new Date('2026-06-16T00:00:00.000Z')
    : null,
  lines,
  ...over,
})

// ── InvariantError contract ────────────────────────────────────────────────

describe('InvariantError — spec 021 §7 (500, internal bug, fail loud)', () => {
  it('is an AppError subclass so the global error handler picks it up', () => {
    const e = new InvariantError('test')
    expect(e).toBeInstanceOf(AppError)
  })

  it('always has statusCode 500 and code INVARIANT_VIOLATED', () => {
    const e = new InvariantError('test')
    expect(e.statusCode).toBe(500)
    expect(e.code).toBe('INVARIANT_VIOLATED')
  })

  it('inherits the 5xx-default `expose: false` so internals are not leaked', () => {
    const e = new InvariantError('test')
    expect(e.expose).toBe(false)
  })
})

// ── §7.1 subjectType ↔ FK consistency ──────────────────────────────────────

describe('assertSubjectFkConsistency — spec 021 §7.1', () => {
  it('passes for CHARITY with only charityId set', () => {
    expect(() => assertSubjectFkConsistency(charityLine())).not.toThrow()
  })

  it('passes for DONATION_PROJECT with only donationProjectId set', () => {
    expect(() => assertSubjectFkConsistency(projectLine())).not.toThrow()
  })

  it('passes for SALE_ITEM with only saleItemId set', () => {
    expect(() => assertSubjectFkConsistency(saleLine())).not.toThrow()
  })

  it('throws when CHARITY has charityId = null', () => {
    expect(() => assertSubjectFkConsistency(charityLine({ charityId: null }))).toThrow(InvariantError)
  })

  it('throws when CHARITY also has donationProjectId set (cross-FK leak)', () => {
    expect(() => assertSubjectFkConsistency(charityLine({ donationProjectId: 'p-x' }))).toThrow(InvariantError)
  })

  it('throws when CHARITY also has saleItemId set', () => {
    expect(() => assertSubjectFkConsistency(charityLine({ saleItemId: 's-x' }))).toThrow(InvariantError)
  })

  it('throws when DONATION_PROJECT has donationProjectId = null', () => {
    expect(() => assertSubjectFkConsistency(projectLine({ donationProjectId: null }))).toThrow(InvariantError)
  })

  it('throws when SALE_ITEM has saleItemId = null', () => {
    expect(() => assertSubjectFkConsistency(saleLine({ saleItemId: null }))).toThrow(InvariantError)
  })
})

// ── §7.2 frequency ↔ billingDay ────────────────────────────────────────────

describe('assertFrequencyBillingDayConsistency — spec 021 §7.2', () => {
  it('passes for CHARITY ONE_TIME with billingDay = null', () => {
    expect(() => assertFrequencyBillingDayConsistency(charityLine())).not.toThrow()
  })

  it('passes for DONATION_PROJECT RECURRING with billingDay set', () => {
    expect(() => assertFrequencyBillingDayConsistency(projectLine())).not.toThrow()
  })

  it('passes for SALE_ITEM with both frequency and billingDay null', () => {
    expect(() => assertFrequencyBillingDayConsistency(saleLine())).not.toThrow()
  })

  it('throws when CHARITY ONE_TIME also sets billingDay', () => {
    expect(() =>
      assertFrequencyBillingDayConsistency(charityLine({ billingDay: 'DAY_6' })),
    ).toThrow(InvariantError)
  })

  it('throws when CHARITY RECURRING is missing billingDay', () => {
    expect(() =>
      assertFrequencyBillingDayConsistency(
        charityLine({ donationFrequency: 'RECURRING', billingDay: null }),
      ),
    ).toThrow(InvariantError)
  })

  it('throws when donation line has donationFrequency = null', () => {
    expect(() =>
      assertFrequencyBillingDayConsistency(charityLine({ donationFrequency: null })),
    ).toThrow(InvariantError)
  })

  it('throws when SALE_ITEM has any donationFrequency set', () => {
    expect(() =>
      assertFrequencyBillingDayConsistency(saleLine({ donationFrequency: 'ONE_TIME' })),
    ).toThrow(InvariantError)
  })

  it('throws when SALE_ITEM has any billingDay set', () => {
    expect(() => assertFrequencyBillingDayConsistency(saleLine({ billingDay: 'DAY_6' }))).toThrow(
      InvariantError,
    )
  })
})

// ── §7.3 amount consistency ────────────────────────────────────────────────

describe('assertAmountConsistency — spec 021 §7.3', () => {
  it('passes when line.subtotalTwd = quantity * unitPriceTwd and Order.amountTwd = sum', () => {
    expect(() => assertAmountConsistency(order([saleLine()]))).not.toThrow()
  })

  it('throws when line.subtotalTwd disagrees with quantity * unitPriceTwd', () => {
    const bad = saleLine({ subtotalTwd: 999 })
    expect(() => assertAmountConsistency(order([bad], { amountTwd: 999 }))).toThrow(InvariantError)
  })

  it('throws when Order.amountTwd disagrees with sum of line subtotals', () => {
    expect(() => assertAmountConsistency(order([saleLine()], { amountTwd: 1 }))).toThrow(
      InvariantError,
    )
  })

  it('throws when quantity is below 1', () => {
    const bad = saleLine({ quantity: 0, subtotalTwd: 0 })
    expect(() => assertAmountConsistency(order([bad], { amountTwd: 0 }))).toThrow(InvariantError)
  })

  it('throws when quantity exceeds 100', () => {
    const bad = saleLine({ quantity: 101, subtotalTwd: 449 * 101 })
    expect(() => assertAmountConsistency(order([bad], { amountTwd: 449 * 101 }))).toThrow(
      InvariantError,
    )
  })
})

// ── §7.4 line count phase-1 limit ──────────────────────────────────────────

describe('assertLineCountWithinPhase1Limit — spec 021 §7.4', () => {
  it('passes for exactly 1 line', () => {
    expect(() => assertLineCountWithinPhase1Limit(order([charityLine()]))).not.toThrow()
  })

  it('throws for 0 lines', () => {
    expect(() => assertLineCountWithinPhase1Limit(order([], { amountTwd: 0 }))).toThrow(
      InvariantError,
    )
  })

  it('throws for 2 lines (phase-1 cap is 1, future cart relaxes this)', () => {
    expect(() =>
      assertLineCountWithinPhase1Limit(order([charityLine(), saleLine()])),
    ).toThrow(InvariantError)
  })
})

// ── §7.5 receiptOption ↔ subjectType ───────────────────────────────────────

describe('assertReceiptOptionConsistency — spec 021 §7.5', () => {
  it('passes when CHARITY order has receiptOption set', () => {
    expect(() => assertReceiptOptionConsistency(order([charityLine()]))).not.toThrow()
  })

  it('passes when DONATION_PROJECT order has receiptOption set', () => {
    expect(() => assertReceiptOptionConsistency(order([projectLine()]))).not.toThrow()
  })

  it('passes when SALE_ITEM order has receiptOption = null', () => {
    expect(() => assertReceiptOptionConsistency(order([saleLine()]))).not.toThrow()
  })

  it('throws when CHARITY order is missing receiptOption', () => {
    expect(() =>
      assertReceiptOptionConsistency(order([charityLine()], { receiptOption: null })),
    ).toThrow(InvariantError)
  })

  it('throws when SALE_ITEM order has a receiptOption set (IMG_4890 has no dropdown)', () => {
    expect(() =>
      assertReceiptOptionConsistency(order([saleLine()], { receiptOption: 'INDIVIDUAL' })),
    ).toThrow(InvariantError)
  })
})

// ── §7.6 nextChargeAt ↔ donationFrequency ──────────────────────────────────

describe('assertNextChargeAtConsistency — spec 021 §7.6', () => {
  it('passes when RECURRING line has order.nextChargeAt set', () => {
    expect(() => assertNextChargeAtConsistency(order([projectLine()]))).not.toThrow()
  })

  it('passes when ONE_TIME donation has order.nextChargeAt = null', () => {
    expect(() => assertNextChargeAtConsistency(order([charityLine()]))).not.toThrow()
  })

  it('passes when SALE_ITEM has order.nextChargeAt = null', () => {
    expect(() => assertNextChargeAtConsistency(order([saleLine()]))).not.toThrow()
  })

  it('throws when RECURRING line is missing order.nextChargeAt', () => {
    expect(() =>
      assertNextChargeAtConsistency(order([projectLine()], { nextChargeAt: null })),
    ).toThrow(InvariantError)
  })

  it('throws when ONE_TIME donation has a stray nextChargeAt', () => {
    expect(() =>
      assertNextChargeAtConsistency(
        order([charityLine()], { nextChargeAt: new Date('2026-07-01T00:00:00.000Z') }),
      ),
    ).toThrow(InvariantError)
  })

  it('throws when SALE_ITEM has a stray nextChargeAt', () => {
    expect(() =>
      assertNextChargeAtConsistency(
        order([saleLine()], { nextChargeAt: new Date('2026-07-01T00:00:00.000Z') }),
      ),
    ).toThrow(InvariantError)
  })
})

// ── aggregate `assertOrderInvariants` ──────────────────────────────────────

describe('assertOrderInvariants — runs every rule in §7.1-§7.6', () => {
  it('passes a fully valid CHARITY ONE_TIME order', () => {
    expect(() => assertOrderInvariants(order([charityLine()]))).not.toThrow()
  })

  it('passes a fully valid DONATION_PROJECT RECURRING order', () => {
    expect(() => assertOrderInvariants(order([projectLine()]))).not.toThrow()
  })

  it('passes a fully valid SALE_ITEM order', () => {
    expect(() => assertOrderInvariants(order([saleLine()]))).not.toThrow()
  })

  it('throws if any single rule is violated (line count + 0 here)', () => {
    expect(() => assertOrderInvariants(order([], { amountTwd: 0 }))).toThrow(InvariantError)
  })

  it('throws if subject FK is inconsistent with subjectType', () => {
    expect(() =>
      assertOrderInvariants(order([charityLine({ charityId: null })])),
    ).toThrow(InvariantError)
  })
})
