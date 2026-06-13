// Spec 009 §5 — Cursor-based pagination helpers.

import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { describe, expect, it } from 'vitest'

import { PageInfoSchema, paginatedEnvelope, paginatedSchema } from './pagination.js'

describe('paginatedEnvelope', () => {
  it('should wrap items with pageInfo containing nextCursor and hasMore (spec 009 §5.3)', () => {
    const result = paginatedEnvelope({
      items: [{ id: '1' }, { id: '2' }],
      nextCursor: 'opaque-token',
      hasMore: true,
    })

    expect(result).toEqual({
      items: [{ id: '1' }, { id: '2' }],
      pageInfo: {
        nextCursor: 'opaque-token',
        hasMore: true,
      },
    })
  })

  it('should return empty items as [] and pageInfo with nextCursor null when no results (spec 009 §11)', () => {
    const result = paginatedEnvelope({ items: [], nextCursor: null, hasMore: false })

    expect(result).toEqual({
      items: [],
      pageInfo: {
        nextCursor: null,
        hasMore: false,
      },
    })
  })

  it('should force nextCursor to null when hasMore is false (spec 009 §5.3 invariant)', () => {
    // Defensive: spec says "hasMore false → nextCursor MUST be null".
    // Helper enforces it instead of trusting the caller.
    const result = paginatedEnvelope({
      items: [{ id: '1' }],
      nextCursor: 'should-be-dropped',
      hasMore: false,
    })

    expect(result.pageInfo.nextCursor).toBeNull()
    expect(result.pageInfo.hasMore).toBe(false)
  })
})

describe('PageInfoSchema', () => {
  it('should validate a pageInfo with string cursor', () => {
    expect(Value.Check(PageInfoSchema, { nextCursor: 'abc', hasMore: true })).toBe(true)
  })

  it('should validate a pageInfo with null cursor', () => {
    expect(Value.Check(PageInfoSchema, { nextCursor: null, hasMore: false })).toBe(true)
  })

  it('should reject a pageInfo missing hasMore', () => {
    expect(Value.Check(PageInfoSchema, { nextCursor: null })).toBe(false)
  })
})

describe('paginatedSchema', () => {
  it('should produce a schema validating { items, pageInfo } envelope (spec 009 §5.3)', () => {
    const ItemSchema = Type.Object({ id: Type.String() })
    const schema = paginatedSchema(ItemSchema)

    expect(
      Value.Check(schema, {
        items: [{ id: '1' }],
        pageInfo: { nextCursor: null, hasMore: false },
      }),
    ).toBe(true)

    expect(
      Value.Check(schema, {
        items: [{ wrong: '1' }],
        pageInfo: { nextCursor: null, hasMore: false },
      }),
    ).toBe(false)
  })
})
