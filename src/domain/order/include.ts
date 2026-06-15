// Spec 022 §4.7 — canonical Prisma `include` shape for any order endpoint
// that returns the hydrated body (3 creates + GET detail + admin list +
// admin detail). One single shape ⇒ list and detail are guaranteed to
// match (§4.7 inflate parity) and the Prisma query plan is identical.
//
// `Prisma.validator` keeps the literal narrow so the `Prisma.OrderGetPayload`
// helper can derive the row type below. Without it the inferred type widens
// to `Prisma.OrderInclude` and downstream consumers lose the
// `lines[].charity.logoKey` field at the type level.

import { Prisma } from '@prisma/client'

export const ORDER_INCLUDE = Prisma.validator<Prisma.OrderInclude>()({
  lines: {
    include: {
      charity: { select: { id: true, name: true, logoKey: true } },
      donationProject: {
        select: {
          id: true,
          name: true,
          charity: { select: { id: true, name: true, logoKey: true } },
        },
      },
      saleItem: {
        select: {
          id: true,
          name: true,
          priceTwd: true,
          charity: { select: { id: true, name: true, logoKey: true } },
        },
      },
    },
    // spec 022 §4.0 — lines[] always sorted (createdAt ASC, id ASC).
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
})

export type HydratedOrder = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>
