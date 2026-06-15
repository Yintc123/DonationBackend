// Spec 020 §5.1 / §6 — Charity admin write schemas.
//
// Two body shapes:
//   * CharityCreateBody — POST /v1/donation/charities (required + optional)
//   * CharityPatchBody  — PATCH /v1/donation/charities/:id (all optional;
//     nullable columns explicitly allow `null` to clear)
//
// Both set `additionalProperties: false` per spec 022 §4.0 strict body
// policy (Fastify Ajv `removeAdditional: false` is wired in app.ts so this
// actually rejects unknown fields).

import { Type, type Static } from '@sinclair/typebox'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

// Field constraints — spec 020 §6 alignment.
const Name = Type.String({ minLength: 1, maxLength: 120 })
const NameOpt = Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 120 })])
const Description = Type.String({ minLength: 1, maxLength: 500 })
const DescriptionOpt = Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 500 })])
const ContactPhone = Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 30 })])
const ContactEmail = Type.Union([
  Type.Null(),
  Type.String({ format: 'email', minLength: 3, maxLength: 254 }),
])
const OfficialWebsite = Type.Union([
  Type.Null(),
  Type.String({ minLength: 1, maxLength: 2048, pattern: '^https?://' }),
])
const ApprovalNo = Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 100 })])
const LogoKey = Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 512 })])
const DisplayOrder = Type.Integer({ minimum: -1000, maximum: 1000 })
const PublishAt = Type.Union([Type.Null(), Type.String({ format: 'date-time' })])
const CategoryIds = Type.Array(Type.String({ pattern: UUID_V4_PATTERN }), {
  minItems: 0,
  maxItems: 16,
})

export const CharityCreateBody = Type.Object(
  {
    name: Name,
    description: Description,
    nameEn: Type.Optional(NameOpt),
    descriptionEn: Type.Optional(DescriptionOpt),
    contactPhone: Type.Optional(ContactPhone),
    contactEmail: Type.Optional(ContactEmail),
    officialWebsite: Type.Optional(OfficialWebsite),
    approvalNo: Type.Optional(ApprovalNo),
    logoKey: Type.Optional(LogoKey),
    displayOrder: Type.Optional(DisplayOrder),
    publishStartAt: Type.Optional(PublishAt),
    publishEndAt: Type.Optional(PublishAt),
    categoryIds: Type.Optional(CategoryIds),
  },
  { additionalProperties: false },
)
export type CharityCreateBodyT = Static<typeof CharityCreateBody>

export const CharityPatchBody = Type.Object(
  {
    name: Type.Optional(Name),
    description: Type.Optional(Description),
    nameEn: Type.Optional(NameOpt),
    descriptionEn: Type.Optional(DescriptionOpt),
    contactPhone: Type.Optional(ContactPhone),
    contactEmail: Type.Optional(ContactEmail),
    officialWebsite: Type.Optional(OfficialWebsite),
    approvalNo: Type.Optional(ApprovalNo),
    logoKey: Type.Optional(LogoKey),
    displayOrder: Type.Optional(DisplayOrder),
    publishStartAt: Type.Optional(PublishAt),
    publishEndAt: Type.Optional(PublishAt),
    categoryIds: Type.Optional(CategoryIds),
  },
  { additionalProperties: false },
)
export type CharityPatchBodyT = Static<typeof CharityPatchBody>
