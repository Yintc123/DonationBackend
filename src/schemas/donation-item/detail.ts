// Spec 017 §3 / §4 / §5 — detail response shapes.
//
// Detail extends the list-item shape with the "詳情頁多出來的欄位"
// (contact info on Charity, content + approval numbers + nested charity
// on Project / SaleItem, priceTwd on SaleItem).

import { Type, type Static } from '@sinclair/typebox'

const InflatedCategory = Type.Object({
  id: Type.String(),
  key: Type.String(),
  displayName: Type.String(),
})

const NestedCharity = Type.Object({
  id: Type.String(),
  name: Type.String(),
  logoUrl: Type.Union([Type.String(), Type.Null()]),
})

export const CharityDetail = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  logoUrl: Type.Union([Type.String(), Type.Null()]),
  contactPhone: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  contactEmail: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  officialWebsite: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  approvalNo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  categories: Type.Array(InflatedCategory),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

export const ProjectDetail = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  logoUrl: Type.Union([Type.String(), Type.Null()]),
  coverImageUrl: Type.Union([Type.String(), Type.Null()]),
  content: Type.String(),
  raisingApprovalNo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  reliefApprovalNo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  charity: NestedCharity,
  categories: Type.Array(InflatedCategory),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

export const SaleItemDetail = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  logoUrl: Type.Union([Type.String(), Type.Null()]),
  coverImageUrl: Type.Union([Type.String(), Type.Null()]),
  content: Type.String(),
  priceTwd: Type.Integer({ minimum: 0 }),
  raisingApprovalNo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  reliefApprovalNo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  charity: NestedCharity,
  categories: Type.Array(InflatedCategory),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

export type CharityDetailT = Static<typeof CharityDetail>
export type ProjectDetailT = Static<typeof ProjectDetail>
export type SaleItemDetailT = Static<typeof SaleItemDetail>
