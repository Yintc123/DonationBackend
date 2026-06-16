// Spec 022 §4.5a (v0.12) — user-side order PATCH service.
//
// Trust model: caller holds the orderId (UUIDv4 not enumerable), same as
// GET / cancel / confirm-payment (spec 022 §2.1 risk table accepted). No
// admin gating here — the route lives on /user/v{N}.
//
// Field whitelist is a strict subset of admin PATCH:
//   donorName / isAnonymous / note / receiptOption
// `status` / `paidAt` / `cancelledAt` / `amountTwd` / `nextChargeAt` /
// `lines` are NOT accepted by the schema (UserPatchBody additionalProperties:
// false). This service trusts the schema-layer rejection and does not
// re-check forbidden fields.
//
// Behaviour summary:
//   - status ∈ {PENDING, PAID}      → allow the patch
//   - status ∈ {CANCELLED, FAILED, REFUNDED} → 409 ORDER_STATUS_INVALID
//   - SALE_ITEM order + non-null receiptOption → 409 INVALID_RECEIPT_OPTION_FOR_SUBJECT
//   - empty patch / value-equal-to-current → 200 + current row, NO audit
//   - fieldsChanged.length > 0 → emit `order_user_patched` (no accountId,
//     because endpoint is unauthenticated)
//
// We re-read the row inside the same transaction as the update so concurrent
// writes can't desync the audit's fieldsChanged calculation. The empty-patch
// no-op skips the transaction entirely.

import type { PrismaClient, ReceiptOption } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'

import { ConflictError, NotFoundError } from '../../lib/errors/index.js'

import { ORDER_INCLUDE, type HydratedOrder } from './include.js'
import { normalizeNote } from './normalize.js'
import { getOrderByIdOrFail } from './query-services.js'

export interface UserPatchInput {
  donorName?: string
  isAnonymous?: boolean
  // null = clear, string = set. Service normalises empty / whitespace-only
  // to null via normalizeNote so "" and "  " behave like null (spec 022
  // §5.2 — matches create / admin PATCH).
  note?: string | null
  // null is the only valid value for SALE_ITEM orders. CHARITY/PROJECT
  // orders may set or clear receiptOption freely.
  receiptOption?: ReceiptOption | null
}

export interface UserPatchDeps {
  prisma: PrismaClient
  logger?: FastifyBaseLogger
}

export async function patchOrderAsUser(
  deps: UserPatchDeps,
  id: string,
  input: UserPatchInput,
): Promise<HydratedOrder> {
  const noteNormalized = normalizeNote(input.note)

  // Empty patch (all undefined) → return current row unchanged. Spec 022 §4.5a:
  // do NOT enter the transaction or emit audit when nothing was sent.
  const noChange =
    input.donorName === undefined &&
    input.isAnonymous === undefined &&
    input.note === undefined &&
    input.receiptOption === undefined
  if (noChange) {
    return getOrderByIdOrFail(deps, id)
  }

  const { fieldsChanged, after } = await deps.prisma.$transaction(async (tx) => {
    // subjectType lives on OrderLine, not Order — pull it via the order
    // header's lines (Phase 1 cap is 1 line / order; we read line[0]).
    const existing = await tx.order.findUnique({
      where: { id },
      select: {
        status: true,
        donorName: true,
        isAnonymous: true,
        note: true,
        receiptOption: true,
        lines: { select: { subjectType: true }, take: 1 },
      },
    })
    if (existing === null) {
      throw notFoundOrder(id)
    }
    const subjectType = existing.lines[0]?.subjectType

    // Status gate — only PENDING / PAID are editable by the user
    // (CANCELLED / FAILED / REFUNDED are accounting-frozen).
    if (existing.status !== 'PENDING' && existing.status !== 'PAID') {
      throw new ConflictError({
        message: `cannot patch when status is ${existing.status}`,
        code: 'ORDER_STATUS_INVALID',
        details: { status: existing.status },
      })
    }

    // SALE_ITEM orders must always have receiptOption === null
    // (spec 021 §7.5 / spec 022 §5.2 v0.12).
    if (
      subjectType === 'SALE_ITEM' &&
      input.receiptOption !== undefined &&
      input.receiptOption !== null
    ) {
      throw new ConflictError({
        message: 'SALE_ITEM orders cannot have receiptOption',
        code: 'INVALID_RECEIPT_OPTION_FOR_SUBJECT',
        details: { subjectType },
      })
    }

    // Compute fieldsChanged from the post-normalisation values vs. existing.
    // Only include fields that the caller actually sent AND whose effective
    // value differs from the current row — so "patch donorName to the
    // current name" does NOT emit audit (spec 022 §10.1 v0.12 no-op test).
    const changed: string[] = []
    if (input.donorName !== undefined && input.donorName !== existing.donorName) {
      changed.push('donorName')
    }
    if (input.isAnonymous !== undefined && input.isAnonymous !== existing.isAnonymous) {
      changed.push('isAnonymous')
    }
    if (input.note !== undefined && noteNormalized !== existing.note) {
      changed.push('note')
    }
    if (input.receiptOption !== undefined && input.receiptOption !== existing.receiptOption) {
      changed.push('receiptOption')
    }

    // Nothing effectively changed — skip the update, return current row.
    if (changed.length === 0) {
      const current = await tx.order.findUnique({ where: { id }, include: ORDER_INCLUDE })
      // current is non-null because we just looked it up above in this txn.
      return { fieldsChanged: changed, after: current! }
    }

    const updated = await tx.order.update({
      where: { id },
      data: {
        donorName: input.donorName,
        isAnonymous: input.isAnonymous,
        note: input.note === undefined ? undefined : noteNormalized,
        receiptOption: input.receiptOption,
      },
      include: ORDER_INCLUDE,
    })
    return { fieldsChanged: changed, after: updated }
  })

  // Spec 022 §9.1 v0.12 — only emit when something actually changed.
  // No accountId because this endpoint is unauthenticated.
  if (fieldsChanged.length > 0) {
    deps.logger?.info({
      event: 'order_user_patched',
      orderId: id,
      fieldsChanged,
      audit: true,
    })
  }

  return after
}

function notFoundOrder(id: string): NotFoundError {
  return new NotFoundError({ resource: 'order', id, code: 'ORDER_NOT_FOUND' })
}
