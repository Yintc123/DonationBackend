// Spec 022 §4.1 + §4.6 — shared response shape for every order endpoint.
//
// One `OrderResponse` is used by:
//   - 3 create endpoints (POST /v1/donation/orders/{charity,project,sale}-...)
//   - GET /v1/donation/orders/:id
//   - confirm-payment / cancel
//   - GET /v1/admin/orders/:id
//   - items[] of GET /v1/admin/orders (list + detail share shape, §4.7)
//
// Inflated subject fields use the "minimal set" per spec 022 §4.1 (id +
// name + image + parent charity for Project / SaleItem). They are nullable
// — only the column matching `subjectType` is populated, the other two
// stay null (mirrors the Prisma `include` shape).

import { Type, type Static } from '@sinclair/typebox'

const InflatedCharity = Type.Object({
  id: Type.String(),
  name: Type.String(),
  logoUrl: Type.Union([Type.Null(), Type.String()]),
})

const InflatedDonationProject = Type.Object({
  id: Type.String(),
  name: Type.String(),
  charity: InflatedCharity,
})

const InflatedSaleItem = Type.Object({
  id: Type.String(),
  name: Type.String(),
  priceTwd: Type.Integer(),
  charity: InflatedCharity,
})

const OrderLineResponse = Type.Object({
  id: Type.String(),
  subjectType: Type.Union([
    Type.Literal('CHARITY'),
    Type.Literal('DONATION_PROJECT'),
    Type.Literal('SALE_ITEM'),
  ]),
  charityId: Type.Union([Type.Null(), Type.String()]),
  donationProjectId: Type.Union([Type.Null(), Type.String()]),
  saleItemId: Type.Union([Type.Null(), Type.String()]),
  quantity: Type.Integer(),
  unitPriceTwd: Type.Integer(),
  subtotalTwd: Type.Integer(),
  donationFrequency: Type.Union([
    Type.Null(),
    Type.Literal('ONE_TIME'),
    Type.Literal('RECURRING'),
  ]),
  billingDay: Type.Union([
    Type.Null(),
    Type.Literal('DAY_6'),
    Type.Literal('DAY_16'),
    Type.Literal('DAY_26'),
  ]),
  createdAt: Type.String({ format: 'date-time' }),
  charity: Type.Union([Type.Null(), InflatedCharity]),
  donationProject: Type.Union([Type.Null(), InflatedDonationProject]),
  saleItem: Type.Union([Type.Null(), InflatedSaleItem]),
})
export type OrderLineResponseT = Static<typeof OrderLineResponse>

export const OrderResponse = Type.Object({
  id: Type.String(),
  status: Type.Union([
    Type.Literal('PENDING'),
    Type.Literal('PAID'),
    Type.Literal('CANCELLED'),
    Type.Literal('FAILED'),
    Type.Literal('REFUNDED'),
  ]),
  donorName: Type.String(),
  isAnonymous: Type.Boolean(),
  receiptOption: Type.Union([
    Type.Null(),
    Type.Literal('NONE'),
    Type.Literal('INDIVIDUAL'),
    Type.Literal('CORPORATE'),
    Type.Literal('GOVERNMENT_DONATION'),
    Type.Literal('DEFER'),
  ]),
  note: Type.Union([Type.Null(), Type.String()]),
  amountTwd: Type.Integer(),
  nextChargeAt: Type.Union([Type.Null(), Type.String({ format: 'date-time' })]),
  lines: Type.Array(OrderLineResponse),
  paidAt: Type.Union([Type.Null(), Type.String({ format: 'date-time' })]),
  cancelledAt: Type.Union([Type.Null(), Type.String({ format: 'date-time' })]),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
})
export type OrderResponseT = Static<typeof OrderResponse>
