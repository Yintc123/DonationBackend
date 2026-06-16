// Spec 016 §4 / §12 — shared list contract for the three donation entities.
//
// `ListQueryBase` is the common shape; `ListQueryWithCharityId` adds the
// `charityId` filter that Project / SaleItem accept (Charity list does not).
// Both Schema objects are passed to Fastify route `schema.querystring`; the
// CATEGORY_KEYS union and uuid pattern give the route layer hard rejection
// of bad input before it touches the service.

import { Type, type Static } from '@sinclair/typebox'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

export const ListQueryBase = Type.Object({
  // Search keyword (matches name + description, locale-selected).
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),

  // Category filter — uses the stable spec 015 §7.1 key.
  // We accept any short string here (`maxLength: 40` matches
  // spec 015 §3.3 — key VARCHAR(40)). The whitelist check happens in
  // `parseCategoryKey` at the route layer, which throws the dedicated
  // CATEGORY_UNKNOWN error (spec 016 §5.1) rather than the generic
  // VALIDATION_FAILED that a `Type.Union(...literals)` would emit.
  category: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),

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

// Spec 026 §5.1.1 — admin list query.
//
// Mostly the same fields as the public list query but:
//   - `limit` cap is 100 (admin UI v0.1 fetches the whole table per page),
//     vs. the public 50 driven by Figma's infinite-scroll cadence
//   - adds two lifecycle toggles (`includeArchived` / `includeDeleted`);
//     both default to false → admin sees `archivedAt IS NULL AND
//     deletedAt IS NULL` (publish window ignored, see spec 026 §2.3)
//
// Defined as a fresh Type.Object rather than Type.Intersect over the
// public base so the admin limit cap isn't shadowed by the public AND
// constraint (Ajv would reject `?limit=100` against the public max=50).
export const AdminListQuery = Type.Object({
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  category: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  includeArchived: Type.Optional(Type.Boolean()),
  includeDeleted: Type.Optional(Type.Boolean()),
})

export const AdminListQueryWithCharityId = Type.Object({
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  category: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  includeArchived: Type.Optional(Type.Boolean()),
  includeDeleted: Type.Optional(Type.Boolean()),
  charityId: Type.Optional(Type.String({ pattern: UUID_V4_PATTERN })),
})

export type AdminListQueryT = Static<typeof AdminListQuery>
export type AdminListQueryWithCharityT = Static<typeof AdminListQueryWithCharityId>
