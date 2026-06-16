// Spec 026 §5.1.1 / §5.2.1 / §5.3.1 — admin list-item shapes + paginated
// response wrappers.
//
// Defined as standalone `Type.Object` (not `Type.Intersect` over the public
// list items) so admin can intentionally diverge from public:
//   - Project / SaleItem list items carry a **nested** `charity: NestedCharity`
//     object (id + name + logoUrl) per spec §5.2.1, instead of the public
//     flat `charityId / charityName` pair (spec 016 §4.4) — the admin UI
//     wants the parent logo at the row level
//   - `createdAt / updatedAt` are omitted (not in the spec §5.1.1 inline
//     shape); cursor pagination still uses `createdAt` internally, but the
//     cursor stays opaque to clients (spec 026 §5 query table)
//
// Wired into Fastify `schema.response[200]` so fast-json-stringify only
// emits fields named here — defence-in-depth even though the admin surface
// is gated.

import { Type, type Static } from '@sinclair/typebox'

import { paginatedSchema } from '../../lib/http/index.js'

import { NestedCharity } from './detail.js'

const InflatedCategory = Type.Object({
  id: Type.String(),
  key: Type.String(),
  displayName: Type.String(),
})

const NullableIsoDate = Type.Union([Type.String(), Type.Null()])

const adminLifecycleProps = {
  displayOrder: Type.Integer(),
  publishStartAt: NullableIsoDate,
  publishEndAt: NullableIsoDate,
  archivedAt: NullableIsoDate,
  deletedAt: NullableIsoDate,
}

export const AdminCharityListItem = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  logoUrl: Type.Union([Type.String(), Type.Null()]),
  categories: Type.Array(InflatedCategory),
  ...adminLifecycleProps,
})

export const AdminProjectListItem = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  logoUrl: Type.Union([Type.String(), Type.Null()]),
  coverImageUrl: Type.Union([Type.String(), Type.Null()]),
  charity: NestedCharity,
  categories: Type.Array(InflatedCategory),
  ...adminLifecycleProps,
})

export const AdminSaleItemListItem = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  logoUrl: Type.Union([Type.String(), Type.Null()]),
  coverImageUrl: Type.Union([Type.String(), Type.Null()]),
  priceTwd: Type.Integer({ minimum: 0 }),
  charity: NestedCharity,
  categories: Type.Array(InflatedCategory),
  ...adminLifecycleProps,
})

export const AdminCharityListResponse = paginatedSchema(AdminCharityListItem)
export const AdminProjectListResponse = paginatedSchema(AdminProjectListItem)
export const AdminSaleItemListResponse = paginatedSchema(AdminSaleItemListItem)

export type AdminCharityListItemT = Static<typeof AdminCharityListItem>
export type AdminProjectListItemT = Static<typeof AdminProjectListItem>
export type AdminSaleItemListItemT = Static<typeof AdminSaleItemListItem>
