// Spec 016 §6.2 / §6.3 — categories dictionary response.

import { Type, type Static } from '@sinclair/typebox'

export const CategoryListItem = Type.Object({
  id: Type.String(),
  key: Type.String(),
  displayName: Type.String(),
  displayOrder: Type.Integer(),
})

export const CategoryListResponse = Type.Object({
  items: Type.Array(CategoryListItem),
})

export type CategoryListItemT = Static<typeof CategoryListItem>
