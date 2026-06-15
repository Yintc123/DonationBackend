// Spec 021 §2.5 / spec 022 §4.1-§4.3 — pure OrderLine constructor.
//
// The create-services pass the validated body + the snapshot of the
// referenced entity (`unitPriceTwd` for SALE_ITEM, the user-typed amount
// for CHARITY / DONATION_PROJECT) into these builders. They return a
// plain object suitable for `prisma.orderLine.create({ data })`. No DB,
// no clock, no IO — pure shape collapse from body to insert.
//
// Putting this logic in a pure helper (not inline in the service)
// matters because (a) the §7.1-§7.6 invariants then have something
// trivially-asserted to consume, and (b) future cart-multi-line will
// just loop this builder per body line.

import { describe, expect, it } from 'vitest'

import {
  buildCharityDonationLine,
  buildProjectDonationLine,
  buildSaleItemPurchaseLine,
} from './line-builder.js'

describe('buildCharityDonationLine — spec 022 §4.1', () => {
  it('builds ONE_TIME line: quantity=1, subtotal=amount, billingDay=null', () => {
    const out = buildCharityDonationLine({
      charityId: 'c-1',
      amountTwd: 500,
      donationFrequency: 'ONE_TIME',
    })
    expect(out).toEqual({
      subjectType: 'CHARITY',
      charityId: 'c-1',
      donationProjectId: null,
      saleItemId: null,
      quantity: 1,
      unitPriceTwd: 500,
      subtotalTwd: 500,
      donationFrequency: 'ONE_TIME',
      billingDay: null,
    })
  })

  it('builds RECURRING line: same as ONE_TIME but billingDay set', () => {
    const out = buildCharityDonationLine({
      charityId: 'c-1',
      amountTwd: 1500,
      donationFrequency: 'RECURRING',
      billingDay: 'DAY_16',
    })
    expect(out.donationFrequency).toBe('RECURRING')
    expect(out.billingDay).toBe('DAY_16')
    expect(out.subtotalTwd).toBe(1500)
  })
})

describe('buildProjectDonationLine — spec 022 §4.2', () => {
  it('builds with donationProjectId set, charityId null', () => {
    const out = buildProjectDonationLine({
      donationProjectId: 'p-1',
      amountTwd: 2000,
      donationFrequency: 'ONE_TIME',
    })
    expect(out.subjectType).toBe('DONATION_PROJECT')
    expect(out.donationProjectId).toBe('p-1')
    expect(out.charityId).toBe(null)
    expect(out.saleItemId).toBe(null)
    expect(out.subtotalTwd).toBe(2000)
  })

  it('passes billingDay through for RECURRING', () => {
    const out = buildProjectDonationLine({
      donationProjectId: 'p-1',
      amountTwd: 500,
      donationFrequency: 'RECURRING',
      billingDay: 'DAY_26',
    })
    expect(out.billingDay).toBe('DAY_26')
  })
})

describe('buildSaleItemPurchaseLine — spec 022 §4.3', () => {
  it('snapshots SaleItem.priceTwd as unitPriceTwd and multiplies by quantity', () => {
    const out = buildSaleItemPurchaseLine({
      saleItemId: 's-1',
      quantity: 2,
      snapshotPriceTwd: 449,
    })
    expect(out).toEqual({
      subjectType: 'SALE_ITEM',
      charityId: null,
      donationProjectId: null,
      saleItemId: 's-1',
      quantity: 2,
      unitPriceTwd: 449,
      subtotalTwd: 898,
      donationFrequency: null,
      billingDay: null,
    })
  })

  it('handles quantity=1 (single-item purchase)', () => {
    const out = buildSaleItemPurchaseLine({
      saleItemId: 's-2',
      quantity: 1,
      snapshotPriceTwd: 299,
    })
    expect(out.subtotalTwd).toBe(299)
    expect(out.quantity).toBe(1)
  })
})
