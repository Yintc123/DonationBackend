// Spec 020 §5.2 — DonationProject admin write schemas.

import { Type, type Static } from '@sinclair/typebox'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const Name = Type.String({ minLength: 1, maxLength: 120 })
const NameOpt = Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 120 })])
const Description = Type.String({ minLength: 1, maxLength: 500 })
const DescriptionOpt = Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 500 })])
const Content = Type.String({ minLength: 1, maxLength: 50000 })
const ContentOpt = Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 50000 })])
const ApprovalNo = Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 100 })])
const ImageKey = Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 512 })])
const DisplayOrder = Type.Integer({ minimum: -1000, maximum: 1000 })
const PublishAt = Type.Union([Type.Null(), Type.String({ format: 'date-time' })])

export const ProjectCreateBody = Type.Object(
  {
    charityId: Type.String({ pattern: UUID_V4_PATTERN }),
    name: Name,
    description: Description,
    content: Content,
    nameEn: Type.Optional(NameOpt),
    descriptionEn: Type.Optional(DescriptionOpt),
    contentEn: Type.Optional(ContentOpt),
    logoKey: Type.Optional(ImageKey),
    coverImageKey: Type.Optional(ImageKey),
    raisingApprovalNo: Type.Optional(ApprovalNo),
    reliefApprovalNo: Type.Optional(ApprovalNo),
    displayOrder: Type.Optional(DisplayOrder),
    publishStartAt: Type.Optional(PublishAt),
    publishEndAt: Type.Optional(PublishAt),
  },
  { additionalProperties: false },
)
export type ProjectCreateBodyT = Static<typeof ProjectCreateBody>

export const ProjectPatchBody = Type.Object(
  {
    // charityId is intentionally NOT patchable — moving a project to a
    // different charity is a separate workflow (would invalidate Order
    // history attribution). Future: dedicated endpoint if needed.
    name: Type.Optional(Name),
    description: Type.Optional(Description),
    content: Type.Optional(Content),
    nameEn: Type.Optional(NameOpt),
    descriptionEn: Type.Optional(DescriptionOpt),
    contentEn: Type.Optional(ContentOpt),
    logoKey: Type.Optional(ImageKey),
    coverImageKey: Type.Optional(ImageKey),
    raisingApprovalNo: Type.Optional(ApprovalNo),
    reliefApprovalNo: Type.Optional(ApprovalNo),
    displayOrder: Type.Optional(DisplayOrder),
    publishStartAt: Type.Optional(PublishAt),
    publishEndAt: Type.Optional(PublishAt),
  },
  { additionalProperties: false },
)
export type ProjectPatchBodyT = Static<typeof ProjectPatchBody>
