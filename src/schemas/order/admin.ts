// Spec 022 §4.7 / §4.9 — admin-only order schemas (list query + patch body).
//
// strict `additionalProperties: false` on every root object so unknown
// query / body fields error with 400 VALIDATION_FAILED (consistent with the
// public create schemas, spec 022 §4.0). PATCH body keeps every field
// optional — the service-layer no-change branch handles the empty body.

import { Type, type Static } from '@sinclair/typebox'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const StatusUnion = Type.Union([
  Type.Literal('PENDING'),
  Type.Literal('PAID'),
  Type.Literal('CANCELLED'),
  Type.Literal('FAILED'),
  Type.Literal('REFUNDED'),
])

const SubjectTypeUnion = Type.Union([
  Type.Literal('CHARITY'),
  Type.Literal('DONATION_PROJECT'),
  Type.Literal('SALE_ITEM'),
])

const ReceiptOptionUnion = Type.Union([
  Type.Literal('NONE'),
  Type.Literal('INDIVIDUAL'),
  Type.Literal('CORPORATE'),
  Type.Literal('GOVERNMENT_DONATION'),
  Type.Literal('DEFER'),
])

// spec 022 §4.7 — admin list query.
export const AdminListQuery = Type.Object(
  {
    status: Type.Optional(StatusUnion),
    subjectType: Type.Optional(SubjectTypeUnion),
    charityId: Type.Optional(Type.String({ pattern: UUID_V4_PATTERN })),
    donationProjectId: Type.Optional(Type.String({ pattern: UUID_V4_PATTERN })),
    saleItemId: Type.Optional(Type.String({ pattern: UUID_V4_PATTERN })),
    // Fastify Ajv coerceTypes: 'array' (default) coerces query strings to
    // booleans for `?isAnonymous=true|false` automatically.
    isAnonymous: Type.Optional(Type.Boolean()),
    receiptOption: Type.Optional(ReceiptOptionUnion),
    dateFrom: Type.Optional(Type.String({ format: 'date-time' })),
    dateTo: Type.Optional(Type.String({ format: 'date-time' })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
  },
  { additionalProperties: false },
)
export type AdminListQueryT = Static<typeof AdminListQuery>

// spec 022 §4.9 — admin PATCH body. All fields optional; whitelist matches
// the service-layer `AdminPatchInput`.
export const AdminPatchBody = Type.Object(
  {
    status: Type.Optional(StatusUnion),
    donorName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    isAnonymous: Type.Optional(Type.Boolean()),
    note: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 500 })])),
    receiptOption: Type.Optional(Type.Union([Type.Null(), ReceiptOptionUnion])),
    paidAt: Type.Optional(Type.Union([Type.Null(), Type.String({ format: 'date-time' })])),
    cancelledAt: Type.Optional(Type.Union([Type.Null(), Type.String({ format: 'date-time' })])),
  },
  { additionalProperties: false },
)
export type AdminPatchBodyT = Static<typeof AdminPatchBody>
