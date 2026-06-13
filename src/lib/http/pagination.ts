// Spec 009 §5 — Cursor-based pagination.
//
// `paginatedEnvelope` is the ONLY place the spec sanctions an envelope on the
// success path (§5.3). All other resource responses go bare per §4.1.
//
// Cursor format itself is opaque to the client (§5.4); this module does not
// own the encoding scheme — handlers compute the cursor and pass it here.

import { type Static, type TSchema, Type } from '@sinclair/typebox'

export const PageInfoSchema = Type.Object({
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  hasMore: Type.Boolean(),
})

export type PageInfo = Static<typeof PageInfoSchema>

export interface PaginatedEnvelope<T> {
  items: T[]
  pageInfo: PageInfo
}

export interface PaginatedInput<T> {
  items: T[]
  nextCursor: string | null
  hasMore: boolean
}

/**
 * Build a paginated response envelope per spec 009 §5.3.
 *
 * Enforces the invariant from §5.3: when `hasMore` is `false`, `nextCursor`
 * is forced to `null` regardless of what the caller passed.
 */
export function paginatedEnvelope<T>(input: PaginatedInput<T>): PaginatedEnvelope<T> {
  const hasMore = input.hasMore
  const nextCursor = hasMore ? input.nextCursor : null

  return {
    items: input.items,
    pageInfo: { nextCursor, hasMore },
  }
}

/**
 * Build a TypeBox schema for a paginated response over `itemSchema`.
 * Intended to be plugged into a Fastify route's `schema.response[200]` so
 * Fastify can serialize-with-validate the envelope (spec 009 §10.1).
 */
export function paginatedSchema<T extends TSchema>(
  itemSchema: T,
): ReturnType<
  typeof Type.Object<{
    items: ReturnType<typeof Type.Array<T>>
    pageInfo: typeof PageInfoSchema
  }>
> {
  return Type.Object({
    items: Type.Array(itemSchema),
    pageInfo: PageInfoSchema,
  })
}
