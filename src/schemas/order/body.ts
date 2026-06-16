// Spec 022 §4.1-§4.3 — request body schemas for the three create endpoints.
//
// Every root `Type.Object` sets `additionalProperties: false` (spec 022 §4.0
// strict-body policy). Unknown properties — e.g. `receiptOption` slipped
// onto a SALE_ITEM body — get rejected at the schema layer with 400
// VALIDATION_FAILED, with no service-layer fallback (we explicitly chose
// to drop RECEIPT_OPTION_NOT_APPLICABLE in v0.7 to avoid double-checking).
//
// TypeBox can't express the conditional "RECURRING ⇒ billingDay required,
// ONE_TIME ⇒ billingDay forbidden" rule cleanly, so we leave `billingDay`
// as optional here and let the service layer throw INVALID_BILLING_DAY
// (same pattern as spec 008 §4.2 at-least-one-identifier).

import { Type, type Static } from '@sinclair/typebox'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const DonorName = Type.String({ minLength: 1, maxLength: 120 })
const IsAnonymous = Type.Optional(Type.Boolean())
// note is optional + nullable; service layer trims and converts "" / all-
// whitespace to null (spec 022 §5.2). We don't enforce minLength: 1 here
// because the client legitimately sends "" when the user blanks the field.
const Note = Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 500 })]))

const DonationFrequencyUnion = Type.Union([Type.Literal('ONE_TIME'), Type.Literal('RECURRING')])
const BillingDayUnion = Type.Union([
  Type.Literal('DAY_6'),
  Type.Literal('DAY_16'),
  Type.Literal('DAY_26'),
])
const ReceiptOptionUnion = Type.Union([
  Type.Literal('NONE'),
  Type.Literal('INDIVIDUAL'),
  Type.Literal('CORPORATE'),
  Type.Literal('GOVERNMENT_DONATION'),
  Type.Literal('DEFER'),
])

const AmountTwd = Type.Integer({ minimum: 1, maximum: 1_000_000 })

// spec 022 §4.1
export const CharityDonationBody = Type.Object(
  {
    donorName: DonorName,
    isAnonymous: IsAnonymous,
    note: Note,
    receiptOption: ReceiptOptionUnion,
    charityId: Type.String({ pattern: UUID_V4_PATTERN }),
    donationFrequency: DonationFrequencyUnion,
    billingDay: Type.Optional(BillingDayUnion),
    amountTwd: AmountTwd,
  },
  { additionalProperties: false },
)
export type CharityDonationBodyT = Static<typeof CharityDonationBody>

// spec 022 §4.2
export const ProjectDonationBody = Type.Object(
  {
    donorName: DonorName,
    isAnonymous: IsAnonymous,
    note: Note,
    receiptOption: ReceiptOptionUnion,
    donationProjectId: Type.String({ pattern: UUID_V4_PATTERN }),
    donationFrequency: DonationFrequencyUnion,
    billingDay: Type.Optional(BillingDayUnion),
    amountTwd: AmountTwd,
  },
  { additionalProperties: false },
)
export type ProjectDonationBodyT = Static<typeof ProjectDonationBody>

// spec 022 §4.3 — SaleItem body has NO receiptOption / donationFrequency /
// billingDay / amountTwd: amount is derived from snapshot SaleItem.priceTwd
// × quantity inside the service (spec 022 §4.3 internal-behavior step 3a).
const SaleItemPurchaseLine = Type.Object(
  {
    saleItemId: Type.String({ pattern: UUID_V4_PATTERN }),
    quantity: Type.Integer({ minimum: 1, maximum: 100 }),
  },
  { additionalProperties: false },
)

export const SaleItemPurchaseBody = Type.Object(
  {
    donorName: DonorName,
    isAnonymous: IsAnonymous,
    note: Note,
    // Phase 1 cap of 1 — future cart relaxes maxItems (spec 022 §11 OQ #3).
    items: Type.Array(SaleItemPurchaseLine, { minItems: 1, maxItems: 1 }),
  },
  { additionalProperties: false },
)
export type SaleItemPurchaseBodyT = Static<typeof SaleItemPurchaseBody>

// spec 022 §4.5a (v0.12) — user-side PATCH body. Whitelist is a strict
// subset of admin PATCH (`status` / `paidAt` / `cancelledAt` are lifecycle-
// controlled and forbidden here; `amountTwd` / `nextChargeAt` / `lines`
// are immutable per spec 021 §7.6 / §7.7). All fields optional — empty
// body is a no-op (service layer returns current row, no audit).
//
// `donorName` here is `Type.Optional` (vs `DonorName` plain in the create
// bodies) so user can omit it without erroring out.
//
// `receiptOption` allows `null` because CHARITY/PROJECT orders may legit-
// imately clear it (e.g. user changed their mind). Service layer rejects
// non-null on SALE_ITEM orders with 409 INVALID_RECEIPT_OPTION_FOR_SUBJECT
// (spec 022 §5.2 v0.12 / spec 021 §7.5).
export const UserPatchBody = Type.Object(
  {
    donorName: Type.Optional(DonorName),
    isAnonymous: IsAnonymous,
    note: Note,
    receiptOption: Type.Optional(Type.Union([Type.Null(), ReceiptOptionUnion])),
  },
  { additionalProperties: false },
)
export type UserPatchBodyT = Static<typeof UserPatchBody>
