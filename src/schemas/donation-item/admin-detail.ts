// Spec 026 §6.1 — admin detail response shapes.
//
// Built as `Type.Intersect([<public schema>, AdminLifecycleFields[, ParentCascadeHints]])`
// so the public detail shapes (spec 017) remain the single source of truth
// for the user-facing fields; admin schemas automatically inherit any
// future column additions on the public side. The five lifecycle columns
// (displayOrder + publishStart/End + archivedAt + deletedAt) are exposed
// only on the admin surface (spec 026 §5).
//
// Project / SaleItem add two `parentCharityArchivedAt` / `parentCharityDeletedAt`
// hint fields so the admin UI can warn the operator that the row is hidden
// in public despite its own lifecycle state being clean (spec 026 §5.2.2,
// cascading visibility from spec 015 v0.9).

import { Type, type Static } from '@sinclair/typebox'

import { CharityDetail, ProjectDetail, SaleItemDetail } from './detail.js'

const NullableIsoDate = Type.Union([Type.String(), Type.Null()])

export const AdminLifecycleFields = Type.Object({
  displayOrder: Type.Integer(),
  publishStartAt: NullableIsoDate,
  publishEndAt: NullableIsoDate,
  archivedAt: NullableIsoDate,
  deletedAt: NullableIsoDate,
})

export const ParentCascadeHints = Type.Object({
  parentCharityArchivedAt: NullableIsoDate,
  parentCharityDeletedAt: NullableIsoDate,
})

export const AdminCharityDetail = Type.Intersect([CharityDetail, AdminLifecycleFields])

export const AdminProjectDetail = Type.Intersect([
  ProjectDetail,
  AdminLifecycleFields,
  ParentCascadeHints,
])

export const AdminSaleItemDetail = Type.Intersect([
  SaleItemDetail,
  AdminLifecycleFields,
  ParentCascadeHints,
])

export type AdminCharityDetailT = Static<typeof AdminCharityDetail>
export type AdminProjectDetailT = Static<typeof AdminProjectDetail>
export type AdminSaleItemDetailT = Static<typeof AdminSaleItemDetail>
