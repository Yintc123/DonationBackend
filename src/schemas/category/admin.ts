// Spec 020 §5.4 — Category admin schemas.
//
// PATCH allows only displayName / displayNameEn / displayOrder. The `key`
// is a TypeScript const literal (see src/domain/category/keys.ts); changing
// it at runtime would orphan every public read filter, so we explicitly
// forbid it via `additionalProperties: false` rather than silently strip.
// Lifecycle stamps go through dedicated POST action endpoints, not PATCH.

import { Type, type Static } from '@sinclair/typebox'

const DisplayName = Type.String({ minLength: 1, maxLength: 80 })
const DisplayNameEnOpt = Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 80 })])
const DisplayOrder = Type.Integer({ minimum: -1000, maximum: 1000 })

export const CategoryPatchBody = Type.Object(
  {
    displayName: Type.Optional(DisplayName),
    displayNameEn: Type.Optional(DisplayNameEnOpt),
    displayOrder: Type.Optional(DisplayOrder),
  },
  { additionalProperties: false },
)
export type CategoryPatchBodyT = Static<typeof CategoryPatchBody>

// Same shape as the public list item (spec 016 §6.2) — admin gets the
// canonical post-update view for free.
export const CategoryAdminResponse = Type.Object({
  id: Type.String(),
  key: Type.String(),
  displayName: Type.String(),
  displayOrder: Type.Integer(),
})
export type CategoryAdminResponseT = Static<typeof CategoryAdminResponse>
