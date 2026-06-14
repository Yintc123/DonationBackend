// Spec 016 §4.3 / §4.4 — list-item response shapes for the three list
// endpoints. Schemas are wired into Fastify `schema.response[200]` so the
// serialiser strips any field the contract doesn't allow (defence-in-depth
// against accidental leakage — e.g. `archivedAt` / `deletedAt` MUST never
// reach the public response).

import { Type, type Static } from '@sinclair/typebox'

import { paginatedSchema } from '../../lib/http/index.js'

const InflatedCategory = Type.Object({
  id: Type.String(),
  key: Type.String(),
  displayName: Type.String(),
})

// Charity list item — simplest of the three (no parent / no price).
export const CharityListItem = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  logoUrl: Type.Union([Type.String(), Type.Null()]),
  categories: Type.Array(InflatedCategory),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

// DonationProject list item — adds parent charityId/name + cover + (inherited) categories.
export const ProjectListItem = Type.Object({
  id: Type.String(),
  charityId: Type.String(),
  charityName: Type.String(),
  name: Type.String(),
  description: Type.String(),
  logoUrl: Type.Union([Type.String(), Type.Null()]),
  coverImageUrl: Type.Union([Type.String(), Type.Null()]),
  categories: Type.Array(InflatedCategory),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

// SaleItem list item — same as Project plus priceTwd.
export const SaleItemListItem = Type.Object({
  id: Type.String(),
  charityId: Type.String(),
  charityName: Type.String(),
  name: Type.String(),
  description: Type.String(),
  logoUrl: Type.Union([Type.String(), Type.Null()]),
  coverImageUrl: Type.Union([Type.String(), Type.Null()]),
  priceTwd: Type.Integer({ minimum: 0 }),
  categories: Type.Array(InflatedCategory),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

export const CharityListResponse = paginatedSchema(CharityListItem)
export const ProjectListResponse = paginatedSchema(ProjectListItem)
export const SaleItemListResponse = paginatedSchema(SaleItemListItem)

export type CharityListItemT = Static<typeof CharityListItem>
export type ProjectListItemT = Static<typeof ProjectListItem>
export type SaleItemListItemT = Static<typeof SaleItemListItem>
