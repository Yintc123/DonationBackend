// Spec 016 §4.5 v0.11 — three-segment cursor.

import { describe, expect, it } from 'vitest'

import { AppError } from '../errors/index.js'

import { decodeCursor, encodeCursor, type CursorPayload } from './cursor.js'

function expectInvalidCursor(fn: () => unknown): void {
  try {
    fn()
  } catch (err) {
    if (!(err instanceof AppError))
      throw new Error(`expected AppError, got: ${String(err)}`)
    expect(err.code).toBe('PAGINATION_CURSOR_INVALID')
    return
  }
  throw new Error('expected decodeCursor to throw')
}

const VALID: CursorPayload = {
  lastDisplayOrder: 0,
  lastCreatedAt: '2026-06-14T12:00:00.000Z',
  lastId: '0e1b41a8-0000-4000-8000-000000000001',
}

describe('encodeCursor', () => {
  it('produces a URL-safe base64 string (no + / =)', () => {
    const s = encodeCursor(VALID)
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('round-trips losslessly', () => {
    const s = encodeCursor(VALID)
    expect(decodeCursor(s)).toEqual(VALID)
  })

  it('encodes negative displayOrder values (admin pin)', () => {
    const p = { ...VALID, lastDisplayOrder: -2 }
    expect(decodeCursor(encodeCursor(p))).toEqual(p)
  })
})

describe('decodeCursor', () => {
  it('throws when input is not valid base64url', () => {
    expectInvalidCursor(() => decodeCursor('not!a!cursor'))
  })

  it('throws when the decoded body is not valid JSON', () => {
    const garbage = Buffer.from('this is not json').toString('base64url')
    expectInvalidCursor(() => decodeCursor(garbage))
  })

  it('throws when displayOrder is missing', () => {
    const body = Buffer.from(
      JSON.stringify({ lastCreatedAt: VALID.lastCreatedAt, lastId: VALID.lastId }),
    ).toString('base64url')
    expectInvalidCursor(() => decodeCursor(body))
  })

  it('throws when createdAt is missing', () => {
    const body = Buffer.from(
      JSON.stringify({ lastDisplayOrder: 0, lastId: VALID.lastId }),
    ).toString('base64url')
    expectInvalidCursor(() => decodeCursor(body))
  })

  it('throws when id is missing', () => {
    const body = Buffer.from(
      JSON.stringify({ lastDisplayOrder: 0, lastCreatedAt: VALID.lastCreatedAt }),
    ).toString('base64url')
    expectInvalidCursor(() => decodeCursor(body))
  })

  it('throws when displayOrder is not an integer', () => {
    const body = Buffer.from(JSON.stringify({ ...VALID, lastDisplayOrder: 0.5 })).toString(
      'base64url',
    )
    expectInvalidCursor(() => decodeCursor(body))
  })

  it('throws when createdAt is not ISO 8601', () => {
    const body = Buffer.from(JSON.stringify({ ...VALID, lastCreatedAt: 'not-a-date' })).toString(
      'base64url',
    )
    expectInvalidCursor(() => decodeCursor(body))
  })

  it('throws when id is not a UUID', () => {
    const body = Buffer.from(JSON.stringify({ ...VALID, lastId: 'not-a-uuid' })).toString(
      'base64url',
    )
    expectInvalidCursor(() => decodeCursor(body))
  })
})
