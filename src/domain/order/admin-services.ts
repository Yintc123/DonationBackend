// Spec 022 §4.7-§4.10 — admin-side order services.
//
// Lives separately from create/lifecycle/query because every function here
// is role=0-gated and they share filter + cursor helpers that none of the
// public endpoints need. The `requireAdmin` preHandler is the route's job
// — this module assumes its caller is already admin.
//
// Cursor format (spec 022 §4.7): 2-segment `(createdAt, id)` descending.
// We can't reuse `src/lib/cursor/cursor.ts` because that one is a 3-segment
// `(displayOrder, createdAt, id)` cursor for donation entities, and the
// order list has no `displayOrder` column. Encoding stays base64url JSON.

import type {
  OrderStatus,
  OrderSubjectType,
  Prisma,
  PrismaClient,
  ReceiptOption,
} from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'

import { BadRequestError, ErrorCode, NotFoundError } from '../../lib/errors/index.js'

import { ORDER_INCLUDE, type HydratedOrder } from './include.js'

// ── Cursor (createdAt DESC, id DESC) ───────────────────────────────────────

interface OrderCursorPayload {
  lastCreatedAt: string
  lastId: string
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/

function invalidCursor(): never {
  throw new BadRequestError({
    code: ErrorCode.PAGINATION_CURSOR_INVALID,
    message: 'pagination cursor is malformed',
  })
}

export function encodeOrderCursor(payload: OrderCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')
}

export function decodeOrderCursor(raw: string): OrderCursorPayload {
  if (typeof raw !== 'string' || raw.length === 0) invalidCursor()
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) invalidCursor()
  let json: string
  try {
    json = Buffer.from(raw, 'base64url').toString('utf-8')
  } catch {
    invalidCursor()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    invalidCursor()
  }
  if (typeof parsed !== 'object' || parsed === null) invalidCursor()
  const obj = parsed as Record<string, unknown>
  if (typeof obj.lastCreatedAt !== 'string' || !ISO_8601_RE.test(obj.lastCreatedAt)) invalidCursor()
  if (typeof obj.lastId !== 'string' || !UUID_RE.test(obj.lastId)) invalidCursor()
  return { lastCreatedAt: obj.lastCreatedAt, lastId: obj.lastId }
}

// ── List ───────────────────────────────────────────────────────────────────

export interface AdminListFilter {
  status?: OrderStatus
  subjectType?: OrderSubjectType
  charityId?: string
  donationProjectId?: string
  saleItemId?: string
  isAnonymous?: boolean
  receiptOption?: ReceiptOption
  dateFrom?: Date
  dateTo?: Date
  cursor?: string
  limit?: number
}

export interface AdminListResult {
  items: HydratedOrder[]
  nextCursor: string | null
  hasMore: boolean
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

export async function listOrdersForAdmin(
  deps: { prisma: PrismaClient },
  filter: AdminListFilter,
): Promise<AdminListResult> {
  const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)

  // Header-level (Order columns).
  const where: Prisma.OrderWhereInput = {}
  if (filter.status) where.status = filter.status
  if (filter.isAnonymous !== undefined) where.isAnonymous = filter.isAnonymous
  if (filter.receiptOption) where.receiptOption = filter.receiptOption
  if (filter.dateFrom !== undefined || filter.dateTo !== undefined) {
    where.createdAt = {
      ...(filter.dateFrom !== undefined ? { gte: filter.dateFrom } : {}),
      // spec 022 §4.7 — half-open [from, to). Use `lt`, not `lte`.
      ...(filter.dateTo !== undefined ? { lt: filter.dateTo } : {}),
    }
  }

  // Line-level (must AND on the same line, per spec 022 §4.7).
  const lineWhere: Prisma.OrderLineWhereInput = {}
  if (filter.subjectType) lineWhere.subjectType = filter.subjectType
  if (filter.charityId) lineWhere.charityId = filter.charityId
  if (filter.donationProjectId) lineWhere.donationProjectId = filter.donationProjectId
  if (filter.saleItemId) lineWhere.saleItemId = filter.saleItemId
  if (Object.keys(lineWhere).length > 0) {
    where.lines = { some: lineWhere }
  }

  // Cursor — (createdAt, id) < (lastCreatedAt, lastId) for DESC ordering.
  if (filter.cursor) {
    const { lastCreatedAt, lastId } = decodeOrderCursor(filter.cursor)
    const lastDate = new Date(lastCreatedAt)
    where.OR = [
      { createdAt: { lt: lastDate } },
      { createdAt: lastDate, id: { lt: lastId } },
    ]
  }

  // Fetch `limit + 1` so we can tell "more pages exist" without a count query.
  const rows = await deps.prisma.order.findMany({
    where,
    include: ORDER_INCLUDE,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  })

  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const tail = items[items.length - 1]
  const nextCursor =
    hasMore && tail
      ? encodeOrderCursor({ lastCreatedAt: tail.createdAt.toISOString(), lastId: tail.id })
      : null

  return { items, nextCursor, hasMore }
}

// ── PATCH ──────────────────────────────────────────────────────────────────

export interface AdminPatchInput {
  status?: OrderStatus
  donorName?: string
  isAnonymous?: boolean
  // null = clear, string = set (trim happens at the route layer for symmetry
  // with create — service trusts post-trim values).
  note?: string | null
  // null is only valid on a SALE_ITEM order (spec 021 §7.5). Service does not
  // re-check subjectType here; the route layer's TypeBox + invariants catch.
  receiptOption?: ReceiptOption | null
  paidAt?: Date | null
  cancelledAt?: Date | null
}

export interface AdminPatchDeps {
  prisma: PrismaClient
  logger?: FastifyBaseLogger
}

/**
 * spec 022 §4.9 — admin partial update.
 *
 * Whitelist of mutable columns: status, donorName, isAnonymous, note,
 * receiptOption, paidAt, cancelledAt. We re-read the row inside the
 * transaction so the audit payload's `statusBefore` / `fieldsChanged`
 * are computed from the post-write state, not a stale snapshot.
 *
 * Spec 021 §10 OQ #7 — orders are immutable on the line / amount / cursor
 * key (id, amountTwd, nextChargeAt, lines, createdAt, updatedAt) — those
 * are filtered out at the schema layer.
 */
export async function patchOrderAsAdmin(
  deps: AdminPatchDeps,
  accountId: string,
  id: string,
  input: AdminPatchInput,
): Promise<HydratedOrder> {
  // Empty patch → return current row unchanged (idempotent no-op, no audit).
  const noChange =
    input.status === undefined &&
    input.donorName === undefined &&
    input.isAnonymous === undefined &&
    input.note === undefined &&
    input.receiptOption === undefined &&
    input.paidAt === undefined &&
    input.cancelledAt === undefined
  if (noChange) {
    const current = await deps.prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE })
    if (current === null) {
      throw notFoundOrder(id)
    }
    return current
  }

  const { before, after } = await deps.prisma.$transaction(async (tx) => {
    const existing = await tx.order.findUnique({ where: { id }, select: { status: true } })
    if (existing === null) {
      throw notFoundOrder(id)
    }
    const updated = await tx.order.update({
      where: { id },
      data: {
        status: input.status,
        donorName: input.donorName,
        isAnonymous: input.isAnonymous,
        note: input.note,
        receiptOption: input.receiptOption,
        paidAt: input.paidAt,
        cancelledAt: input.cancelledAt,
      },
      include: ORDER_INCLUDE,
    })
    return { before: existing.status, after: updated }
  })

  // Spec 022 §9.1 — emit audit with fieldsChanged.
  const fieldsChanged: string[] = []
  if (input.status !== undefined && input.status !== before) fieldsChanged.push('status')
  if (input.donorName !== undefined) fieldsChanged.push('donorName')
  if (input.isAnonymous !== undefined) fieldsChanged.push('isAnonymous')
  if (input.note !== undefined) fieldsChanged.push('note')
  if (input.receiptOption !== undefined) fieldsChanged.push('receiptOption')
  if (input.paidAt !== undefined) fieldsChanged.push('paidAt')
  if (input.cancelledAt !== undefined) fieldsChanged.push('cancelledAt')

  deps.logger?.info({
    event: 'order_admin_patched',
    orderId: id,
    accountId,
    statusBefore: before,
    statusAfter: after.status,
    fieldsChanged,
    audit: true,
  })

  return after
}

// ── DELETE (hard) ──────────────────────────────────────────────────────────

export async function deleteOrderAsAdmin(
  deps: { prisma: PrismaClient; logger?: FastifyBaseLogger },
  accountId: string,
  id: string,
): Promise<void> {
  try {
    await deps.prisma.order.delete({ where: { id } })
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === 'P2025'
    ) {
      throw notFoundOrder(id)
    }
    throw err
  }
  // Spec 022 §9.1 — warn-level (destructive).
  deps.logger?.warn({
    event: 'order_admin_deleted',
    orderId: id,
    accountId,
    audit: true,
  })
}

// ── Helpers ────────────────────────────────────────────────────────────────

function notFoundOrder(id: string): NotFoundError {
  return new NotFoundError({ resource: 'order', id, code: 'ORDER_NOT_FOUND' })
}
