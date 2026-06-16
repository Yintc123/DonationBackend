// Backend ADR 006 §2 / §3 — lifecycle filter helpers.
//
// We treat the returned shape as data, not as opaque structure. The
// assertions inspect the literal keys so changes to the shape stay
// intentional (Prisma's where DSL is part of our public contract with
// route / domain code).

import { describe, expect, it } from 'vitest'

import { whereForAdmin, whereLive, whereLiveWithParent } from './where.js'

const NOW = new Date('2026-06-14T12:00:00.000Z')

describe('whereLive(now) — ADR 006 §2', () => {
  it('returns deletedAt: null and archivedAt: null at the top level', () => {
    const w = whereLive(NOW)
    expect(w.deletedAt).toBe(null)
    expect(w.archivedAt).toBe(null)
  })

  it('encodes the publish window as an AND of two ORs (Prisma idiom for conjoined ORs)', () => {
    const w = whereLive(NOW)
    expect(w.AND).toEqual([
      { OR: [{ publishStartAt: null }, { publishStartAt: { lte: NOW } }] },
      { OR: [{ publishEndAt: null }, { publishEndAt: { gt: NOW } }] },
    ])
  })

  it('a different `now` flows through to both publish predicates', () => {
    const later = new Date('2030-01-01T00:00:00.000Z')
    const w = whereLive(later)
    expect(w.AND[0]?.OR[1]).toEqual({ publishStartAt: { lte: later } })
    expect(w.AND[1]?.OR[1]).toEqual({ publishEndAt: { gt: later } })
  })

  it('does not mutate the input timestamp', () => {
    const before = NOW.getTime()
    whereLive(NOW)
    expect(NOW.getTime()).toBe(before)
  })

  it('returns a fresh object each call (no shared reference between callers)', () => {
    const a = whereLive(NOW)
    const b = whereLive(NOW)
    expect(a).not.toBe(b)
    expect(a.AND).not.toBe(b.AND)
  })
})

describe('whereLiveWithParent(now) — ADR 006 §3 cascading visibility', () => {
  it('keeps every key from whereLive at the top level', () => {
    const child = whereLive(NOW)
    const wrapped = whereLiveWithParent(NOW)
    expect(wrapped.deletedAt).toBe(child.deletedAt)
    expect(wrapped.archivedAt).toBe(child.archivedAt)
    expect(wrapped.AND).toEqual(child.AND)
  })

  it('adds a parent `charity.is = whereLive(now)` clause', () => {
    const wrapped = whereLiveWithParent(NOW)
    expect(wrapped.charity).toEqual({ is: whereLive(NOW) })
  })

  it('the parent clause uses the SAME `now` as the child', () => {
    const wrapped = whereLiveWithParent(NOW)
    // Same shape as whereLive(NOW) for the parent side.
    expect(wrapped.charity.is.AND[0]?.OR[1]).toEqual({ publishStartAt: { lte: NOW } })
    expect(wrapped.charity.is.AND[1]?.OR[1]).toEqual({ publishEndAt: { gt: NOW } })
  })
})

describe('whereForAdmin(opts) — spec 026 §2.3 / spec 015 §3.3 v0.9', () => {
  it('default (no flags) filters out both archived and deleted rows', () => {
    const w = whereForAdmin({ includeArchived: false, includeDeleted: false })
    expect(w).toEqual({ archivedAt: null, deletedAt: null })
  })

  it('includeArchived=true drops the archivedAt clause but keeps deletedAt', () => {
    const w = whereForAdmin({ includeArchived: true, includeDeleted: false })
    expect(w).toEqual({ deletedAt: null })
    expect('archivedAt' in w).toBe(false)
  })

  it('includeDeleted=true drops the deletedAt clause but keeps archivedAt', () => {
    const w = whereForAdmin({ includeArchived: false, includeDeleted: true })
    expect(w).toEqual({ archivedAt: null })
    expect('deletedAt' in w).toBe(false)
  })

  it('both flags true returns the empty filter (full row set)', () => {
    const w = whereForAdmin({ includeArchived: true, includeDeleted: true })
    expect(w).toEqual({})
  })

  it('does NOT include publishStartAt / publishEndAt — admin must see scheduled rows', () => {
    const w = whereForAdmin({ includeArchived: false, includeDeleted: false })
    expect('publishStartAt' in w).toBe(false)
    expect('publishEndAt' in w).toBe(false)
    expect('AND' in w).toBe(false)
  })

  it('returns a fresh object each call (no shared reference)', () => {
    const a = whereForAdmin({ includeArchived: false, includeDeleted: false })
    const b = whereForAdmin({ includeArchived: false, includeDeleted: false })
    expect(a).not.toBe(b)
  })
})
