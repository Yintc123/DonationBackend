// Spec 021 §2.5 / spec 022 §4.1-§4.3 — pure OrderLine constructors.
//
// One builder per create-endpoint shape. Each takes the post-validation
// body plus any snapshot data the service has pulled from the DB
// (SaleItem.priceTwd for purchase; nothing else today) and returns a
// `Prisma.OrderLineUncheckedCreateWithoutOrderInput`-compatible object.
//
// We return our own structural type instead of importing Prisma's
// `Prisma.OrderLineUncheckedCreateWithoutOrderInput` so:
//   1. tests don't need a Prisma client fixture,
//   2. validators.ts can consume the same shape via OrderLineLike,
//   3. there's no implicit DB dependency creeping into a pure function.

import type {
  BillingDay,
  DonationFrequency,
  OrderSubjectType,
} from '@prisma/client'

export interface OrderLineCreateInput {
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

export interface CharityDonationLineInput {
  charityId: string
  amountTwd: number
  donationFrequency: DonationFrequency
  billingDay?: BillingDay
}

export function buildCharityDonationLine(input: CharityDonationLineInput): OrderLineCreateInput {
  return {
    subjectType: 'CHARITY',
    charityId: input.charityId,
    donationProjectId: null,
    saleItemId: null,
    quantity: 1,
    unitPriceTwd: input.amountTwd,
    subtotalTwd: input.amountTwd,
    donationFrequency: input.donationFrequency,
    billingDay: input.billingDay ?? null,
  }
}

export interface ProjectDonationLineInput {
  donationProjectId: string
  amountTwd: number
  donationFrequency: DonationFrequency
  billingDay?: BillingDay
}

export function buildProjectDonationLine(input: ProjectDonationLineInput): OrderLineCreateInput {
  return {
    subjectType: 'DONATION_PROJECT',
    charityId: null,
    donationProjectId: input.donationProjectId,
    saleItemId: null,
    quantity: 1,
    unitPriceTwd: input.amountTwd,
    subtotalTwd: input.amountTwd,
    donationFrequency: input.donationFrequency,
    billingDay: input.billingDay ?? null,
  }
}

export interface SaleItemPurchaseLineInput {
  saleItemId: string
  quantity: number
  snapshotPriceTwd: number
}

export function buildSaleItemPurchaseLine(input: SaleItemPurchaseLineInput): OrderLineCreateInput {
  return {
    subjectType: 'SALE_ITEM',
    charityId: null,
    donationProjectId: null,
    saleItemId: input.saleItemId,
    quantity: input.quantity,
    unitPriceTwd: input.snapshotPriceTwd,
    subtotalTwd: input.quantity * input.snapshotPriceTwd,
    donationFrequency: null,
    billingDay: null,
  }
}
