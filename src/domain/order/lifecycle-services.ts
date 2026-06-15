// Spec 022 §4.4 / §4.5 — confirm-payment / cancel state-machine services.
//
//        ┌──────────┐  confirmPayment  ┌──────┐
//        │ PENDING  │ ───────────────► │ PAID │
//        └────┬─────┘                  └──────┘
//             │ cancelOrder
//             ▼
//        ┌───────────┐
//        │ CANCELLED │
//        └───────────┘
//   FAILED / REFUNDED — no user-driven transition (admin PATCH only,
//                       Phase 4 / spec 022 §4.9)
//
// Idempotency contract (spec 022 §4.4 / §4.5):
//   - `confirmPayment` is a no-op 200 when the order is already PAID.
//   - `cancelOrder`     is a no-op 200 when the order is already CANCELLED.
// Any other starting status → 409 ORDER_STATUS_INVALID.
//
// Concurrency: the conditional `updateMany({ where: { id, status } })` is
// atomic — if two callers race a PENDING confirm, exactly one row update
// returns `count: 1`, the other gets `count: 0` and re-reads to discover
// the new (now PAID) state, which it then treats as the idempotent path.
// We do this in a single transaction so the audit emit on the winning
// branch is guaranteed to land alongside the row write.

import type { PrismaClient } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'

import type { Clock } from '../../lib/clock.js'
import { ConflictError } from '../../lib/errors/index.js'

import { ORDER_INCLUDE, type HydratedOrder } from './include.js'
import { getOrderByIdOrFail } from './query-services.js'

export interface OrderLifecycleDeps {
  prisma: PrismaClient
  clock: Clock
  logger?: FastifyBaseLogger
}

function emitAudit(
  logger: FastifyBaseLogger | undefined,
  event: 'order_payment_confirmed' | 'order_cancelled',
  orderId: string,
): void {
  // Spec 022 §9.1 — idempotent no-ops MUST NOT emit; only real transitions.
  logger?.info({ event, orderId, audit: true })
}

// ── confirmPayment (spec 022 §4.4) ─────────────────────────────────────────

export async function confirmPayment(
  deps: OrderLifecycleDeps,
  id: string,
): Promise<HydratedOrder> {
  const now = deps.clock()
  const { transitioned, status } = await deps.prisma.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'PAID', paidAt: now },
    })
    if (updated.count === 1) {
      return { transitioned: true as const, status: 'PAID' as const }
    }
    // Either the row doesn't exist or it isn't PENDING — re-read to find out.
    const existing = await tx.order.findUnique({ where: { id }, select: { status: true } })
    return { transitioned: false as const, status: existing?.status ?? null }
  })

  if (status === null) {
    // 404 via `getOrderByIdOrFail` for symmetric error shape with §4.6.
    await getOrderByIdOrFail(deps, id)
    // unreachable — getOrderByIdOrFail throws
    throw new Error('unreachable')
  }
  if (!transitioned && status !== 'PAID') {
    throw new ConflictError({
      message: `cannot confirm-payment when status is ${status}`,
      code: 'ORDER_STATUS_INVALID',
      details: { status },
    })
  }
  if (transitioned) {
    emitAudit(deps.logger, 'order_payment_confirmed', id)
  }
  return deps.prisma.order.findUniqueOrThrow({ where: { id }, include: ORDER_INCLUDE })
}

// ── cancelOrder (spec 022 §4.5) ────────────────────────────────────────────

export async function cancelOrder(
  deps: OrderLifecycleDeps,
  id: string,
): Promise<HydratedOrder> {
  const now = deps.clock()
  const { transitioned, status } = await deps.prisma.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: now },
    })
    if (updated.count === 1) {
      return { transitioned: true as const, status: 'CANCELLED' as const }
    }
    const existing = await tx.order.findUnique({ where: { id }, select: { status: true } })
    return { transitioned: false as const, status: existing?.status ?? null }
  })

  if (status === null) {
    await getOrderByIdOrFail(deps, id)
    throw new Error('unreachable')
  }
  if (!transitioned && status !== 'CANCELLED') {
    throw new ConflictError({
      message: `cannot cancel when status is ${status}`,
      code: 'ORDER_STATUS_INVALID',
      details: { status },
    })
  }
  if (transitioned) {
    emitAudit(deps.logger, 'order_cancelled', id)
  }
  return deps.prisma.order.findUniqueOrThrow({ where: { id }, include: ORDER_INCLUDE })
}
