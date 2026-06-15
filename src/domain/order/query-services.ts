// Spec 022 §4.6 / §4.8 — read-only order queries.
//
// One canonical "fetch by id with full hydration" function shared by:
//   - public GET /v1/donation/orders/:id           (§4.6, no auth)
//   - confirm-payment / cancel "re-read after transition" step
//   - admin GET /v1/admin/orders/:id               (§4.8, role=0; Phase 4)
//
// Going through a single function guarantees the include shape — and
// therefore the response — stays in lock-step between every entry point
// (spec 022 §4.7 inflate parity).
//
// The "no auth required" risk is accepted at spec 022 §2.1 (UUIDv4 is
// not enumerable). This function therefore returns whatever it finds
// regardless of caller; gating is the route's job, not the service's.

import type { PrismaClient } from '@prisma/client'

import { NotFoundError } from '../../lib/errors/index.js'

import { ORDER_INCLUDE, type HydratedOrder } from './include.js'

export interface OrderReadDeps {
  prisma: PrismaClient
}

/**
 * Throws `ORDER_NOT_FOUND` (404) when missing. Use this for endpoints
 * where a missing row is a client-visible error.
 */
export async function getOrderByIdOrFail(
  deps: OrderReadDeps,
  id: string,
): Promise<HydratedOrder> {
  const order = await deps.prisma.order.findUnique({
    where: { id },
    include: ORDER_INCLUDE,
  })
  if (!order) {
    throw new NotFoundError({ resource: 'order', id, code: 'ORDER_NOT_FOUND' })
  }
  return order
}
