// Spec 016 §4 / §12 — shared list contract for the three donation entities.
//
// `ListQueryBase` is the common shape; `ListQueryWithCharityId` adds the
// `charityId` filter that Project / SaleItem accept (Charity list does not).
// Both Schema objects are passed to Fastify route `schema.querystring`; the
// CATEGORY_KEYS union and uuid pattern give the route layer hard rejection
// of bad input before it touches the service.

import { Type, type Static } from '@sinclair/typebox'

import { CATEGORY_KEYS } from '../../domain/category/keys.js'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

export const ListQueryBase = Type.Object({
  // Search keyword (matches name + description, locale-selected).
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),

  // Category filter — uses the stable spec 015 §7.1 key.
  // The Union of literals is what gives us CATEGORY_UNKNOWN at the route
  // layer (spec 016 §5.1) — Fastify rejects typos before they reach service.
  category: Type.Optional(Type.Union(CATEGORY_KEYS.map((k) => Type.Literal(k)))),

  // Cursor opaque to the client — service decodes per spec 016 §4.5.
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),

  // Default 10 (Figma-driven infinite scroll page size, spec 016 §4.2).
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
})

export type ListQuery = Static<typeof ListQueryBase>

export const ListQueryWithCharityId = Type.Intersect([
  ListQueryBase,
  Type.Object({
    charityId: Type.Optional(Type.String({ pattern: UUID_V4_PATTERN })),
  }),
])

export type ListQueryWithCharity = Static<typeof ListQueryWithCharityId>
