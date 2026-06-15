// Spec 022 §4.1 / §4.7 — wire-format serializer.
//
// Responsibilities:
//   - Inflate `logoKey` → `logoUrl` via the spec 018 object-url builder.
//   - Convert Prisma `Date` columns to ISO 8601 strings (spec 022 §4.0).
//   - Project to the minimal "inflated subject" shape per IMG_4888-4890
//     (id / name / image; SaleItem also `priceTwd` — spec 022 §4.1 v0.6).
//
// We do this in one place so list (§4.7 admin) and detail (§4.6 public)
// stay in lock-step. The serializer is pure — pass an `objectUrl` function
// in, get a plain JSON-ready object out.

import type { HydratedOrder } from './include.js'
import type { OrderLineResponseT, OrderResponseT } from '../../schemas/order/response.js'

export type ObjectUrl = (key: string) => string

type HydratedLine = HydratedOrder['lines'][number]
type HydratedCharityLink = NonNullable<HydratedLine['charity']>
type HydratedProjectLink = NonNullable<HydratedLine['donationProject']>
type HydratedSaleItemLink = NonNullable<HydratedLine['saleItem']>

function inflateCharity(
  charity: HydratedCharityLink | { id: string; name: string; logoKey: string | null },
  objectUrl: ObjectUrl,
): { id: string; name: string; logoUrl: string | null } {
  return {
    id: charity.id,
    name: charity.name,
    logoUrl: charity.logoKey ? objectUrl(charity.logoKey) : null,
  }
}

function inflateProject(
  project: HydratedProjectLink,
  objectUrl: ObjectUrl,
): NonNullable<OrderLineResponseT['donationProject']> {
  return {
    id: project.id,
    name: project.name,
    charity: inflateCharity(project.charity, objectUrl),
  }
}

function inflateSaleItem(
  saleItem: HydratedSaleItemLink,
  objectUrl: ObjectUrl,
): NonNullable<OrderLineResponseT['saleItem']> {
  return {
    id: saleItem.id,
    name: saleItem.name,
    priceTwd: saleItem.priceTwd,
    charity: inflateCharity(saleItem.charity, objectUrl),
  }
}

function serializeLine(line: HydratedLine, objectUrl: ObjectUrl): OrderLineResponseT {
  return {
    id: line.id,
    subjectType: line.subjectType,
    charityId: line.charityId,
    donationProjectId: line.donationProjectId,
    saleItemId: line.saleItemId,
    quantity: line.quantity,
    unitPriceTwd: line.unitPriceTwd,
    subtotalTwd: line.subtotalTwd,
    donationFrequency: line.donationFrequency,
    billingDay: line.billingDay,
    createdAt: line.createdAt.toISOString(),
    charity: line.charity ? inflateCharity(line.charity, objectUrl) : null,
    donationProject: line.donationProject ? inflateProject(line.donationProject, objectUrl) : null,
    saleItem: line.saleItem ? inflateSaleItem(line.saleItem, objectUrl) : null,
  }
}

export function serializeOrder(order: HydratedOrder, objectUrl: ObjectUrl): OrderResponseT {
  return {
    id: order.id,
    status: order.status,
    donorName: order.donorName,
    isAnonymous: order.isAnonymous,
    receiptOption: order.receiptOption,
    note: order.note,
    amountTwd: order.amountTwd,
    nextChargeAt: order.nextChargeAt?.toISOString() ?? null,
    lines: order.lines.map((l) => serializeLine(l, objectUrl)),
    paidAt: order.paidAt?.toISOString() ?? null,
    cancelledAt: order.cancelledAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  }
}
