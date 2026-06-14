// Spec 016 §4.5 v0.11 — three-segment cursor for donation list endpoints.
//
// Cursor payload is the (displayOrder, createdAt, id) tuple of the last
// item on the previous page. Decoded cursors are validated structurally
// — malformed input → `PAGINATION_CURSOR_INVALID` (spec 005 / spec 016 §5.1).
//
// We do NOT cryptographically sign the cursor — it carries no privileged
// data, just a tiebreaker. Tampering at worst skews pagination order, which
// the client already controls anyway.

import { BadRequestError, ErrorCode } from '../errors/index.js'

export interface CursorPayload {
  lastDisplayOrder: number
  lastCreatedAt: string
  lastId: string
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/

function invalid(): never {
  throw new BadRequestError({
    code: ErrorCode.PAGINATION_CURSOR_INVALID,
    message: 'pagination cursor is malformed',
  })
}

export function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf-8').toString('base64url')
}

export function decodeCursor(raw: string): CursorPayload {
  if (typeof raw !== 'string' || raw.length === 0) invalid()
  // Reject characters outside the base64url alphabet — Buffer.from is too
  // permissive (silently skips invalid bytes).
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) invalid()

  let json: string
  try {
    json = Buffer.from(raw, 'base64url').toString('utf-8')
  } catch {
    invalid()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    invalid()
  }

  if (typeof parsed !== 'object' || parsed === null) invalid()
  const obj = parsed as Record<string, unknown>

  const displayOrder = obj.lastDisplayOrder
  const createdAt = obj.lastCreatedAt
  const id = obj.lastId

  if (typeof displayOrder !== 'number' || !Number.isInteger(displayOrder)) invalid()
  if (typeof createdAt !== 'string' || !ISO_8601_RE.test(createdAt)) invalid()
  if (typeof id !== 'string' || !UUID_RE.test(id)) invalid()

  return { lastDisplayOrder: displayOrder, lastCreatedAt: createdAt, lastId: id }
}
