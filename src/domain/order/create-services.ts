// Spec 022 §4.1-§4.3 — three create services for the donation order domain.
//
// Each service takes the validated request body + injected deps (Prisma +
// Clock) and returns a hydrated order row that the route layer can hand
// to `serializeOrder` for the wire response.
//
// The shape is the same for all three:
//   1. Service-layer conditional check (RECURRING ↔ billingDay) — TypeBox
//      can't express "if frequency=RECURRING then billingDay required"
//      cleanly, so the service throws 400 INVALID_BILLING_DAY here.
//      Sale-item purchase has no frequency at all, so it skips this step.
//   2. Lookup the referenced entity against `whereLive` / `whereLiveWithParent`
//      so cooperation-contract expiry (spec 015 cascading visibility) flows
//      through to "can I create an order for this subject?". Miss → 404.
//   3. Open a Prisma transaction; create Order + its single OrderLine in one
//      nested write so failure rolls back atomically. Inside the
//      transaction, run `assertOrderInvariants` on the freshly-created row
//      — anything caught here is a code bug, not user error (spec 021 §7).
//   4. Re-read the row with the canonical `ORDER_INCLUDE` shape so the
//      route layer sees the inflated subjects without an extra query.
//   5. Emit `order_created` for the audit log (spec 022 §9).
//
// The transaction body uses the `tx` client (typed as `Prisma.TransactionClient`)
// — we explicitly DO NOT use `deps.prisma` inside the callback so any
// review reading the code sees the atomicity boundary at a glance.

import type { PrismaClient, Prisma } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'

import { whereLive, whereLiveWithParent } from '../lifecycle/index.js'
import { BadRequestError, NotFoundError } from '../../lib/errors/index.js'
import type { Clock } from '../../lib/clock.js'

import { ORDER_INCLUDE, type HydratedOrder } from './include.js'
import {
  buildCharityDonationLine,
  buildProjectDonationLine,
  buildSaleItemPurchaseLine,
  type OrderLineCreateInput,
} from './line-builder.js'
import { computeNextChargeAt } from './next-charge-at.js'
import { assertOrderInvariants } from './validators.js'

import type {
  CharityDonationBodyT,
  ProjectDonationBodyT,
  SaleItemPurchaseBodyT,
} from '../../schemas/order/body.js'

// ── Dependencies ───────────────────────────────────────────────────────────

export interface OrderServiceDeps {
  prisma: PrismaClient
  clock: Clock
  logger?: FastifyBaseLogger
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Spec 022 §5.2 — note normalisation rule:
 * trim whitespace; empty (or whitespace-only) string collapses to `null`
 * so the DB never carries the dual "" / null "no note" representation.
 */
function normalizeNote(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Spec 022 §5.2 — RECURRING ⇔ billingDay biconditional. TypeBox keeps
 * billingDay optional at the schema layer; here we close the loop.
 */
function assertFrequencyBillingDayPair(
  frequency: 'ONE_TIME' | 'RECURRING',
  billingDay: 'DAY_6' | 'DAY_16' | 'DAY_26' | undefined,
): void {
  if (frequency === 'RECURRING' && billingDay === undefined) {
    throw new BadRequestError({
      message: 'RECURRING donations must specify billingDay',
      code: 'INVALID_BILLING_DAY',
    })
  }
  if (frequency === 'ONE_TIME' && billingDay !== undefined) {
    throw new BadRequestError({
      message: 'ONE_TIME donations must not specify billingDay',
      code: 'INVALID_BILLING_DAY',
    })
  }
}

/**
 * Single-shot atomic write + invariant assertion + hydrated re-read.
 * All three create flows share this code path; the caller assembles
 * the order-level data + the single line input.
 */
async function persistOrderWithLine(
  deps: OrderServiceDeps,
  data: Omit<Prisma.OrderCreateInput, 'lines'>,
  line: OrderLineCreateInput,
): Promise<HydratedOrder> {
  return deps.prisma.$transaction(async (tx) => {
    const created = await tx.order.create({
      data: {
        ...data,
        lines: { create: [line] },
      },
      include: ORDER_INCLUDE,
    })
    // Spec 021 §7 — last-line-of-defence; throws InvariantError (500) on
    // any structural bug. Rolls back the transaction via throw.
    assertOrderInvariants(created)
    return created
  })
}

function emitOrderCreatedAudit(
  logger: FastifyBaseLogger | undefined,
  orderId: string,
  subjectType: 'CHARITY' | 'DONATION_PROJECT' | 'SALE_ITEM',
  lineCount: number,
): void {
  // Spec 022 §9.1 — payload contract; redact rules in spec 004 §7.1 already
  // strip the request-id / accountId etc. centrally so we just include the
  // event-level fields here.
  logger?.info({ event: 'order_created', orderId, subjectType, lineCount, audit: true })
}

// ── §4.1 createCharityDonation ─────────────────────────────────────────────

export async function createCharityDonation(
  deps: OrderServiceDeps,
  input: CharityDonationBodyT,
): Promise<HydratedOrder> {
  assertFrequencyBillingDayPair(input.donationFrequency, input.billingDay)

  const now = deps.clock()
  const charity = await deps.prisma.charity.findFirst({
    where: { id: input.charityId, ...whereLive(now) },
    select: { id: true },
  })
  if (!charity) {
    throw new NotFoundError({
      resource: 'charity',
      id: input.charityId,
      code: 'CHARITY_NOT_FOUND',
    })
  }

  const line = buildCharityDonationLine({
    charityId: charity.id,
    amountTwd: input.amountTwd,
    donationFrequency: input.donationFrequency,
    billingDay: input.billingDay,
  })

  const nextChargeAt =
    input.donationFrequency === 'RECURRING' ? computeNextChargeAt(now, input.billingDay!) : null

  const order = await persistOrderWithLine(
    deps,
    {
      donorName: input.donorName,
      isAnonymous: input.isAnonymous ?? false,
      receiptOption: input.receiptOption,
      note: normalizeNote(input.note),
      nextChargeAt,
      amountTwd: line.subtotalTwd,
    },
    line,
  )

  emitOrderCreatedAudit(deps.logger, order.id, 'CHARITY', order.lines.length)
  return order
}

// ── §4.2 createProjectDonation ─────────────────────────────────────────────

export async function createProjectDonation(
  deps: OrderServiceDeps,
  input: ProjectDonationBodyT,
): Promise<HydratedOrder> {
  assertFrequencyBillingDayPair(input.donationFrequency, input.billingDay)

  const now = deps.clock()
  const project = await deps.prisma.donationProject.findFirst({
    where: { id: input.donationProjectId, ...whereLiveWithParent(now) },
    select: { id: true },
  })
  if (!project) {
    throw new NotFoundError({
      resource: 'donation_project',
      id: input.donationProjectId,
      code: 'DONATION_PROJECT_NOT_FOUND',
    })
  }

  const line = buildProjectDonationLine({
    donationProjectId: project.id,
    amountTwd: input.amountTwd,
    donationFrequency: input.donationFrequency,
    billingDay: input.billingDay,
  })

  const nextChargeAt =
    input.donationFrequency === 'RECURRING' ? computeNextChargeAt(now, input.billingDay!) : null

  const order = await persistOrderWithLine(
    deps,
    {
      donorName: input.donorName,
      isAnonymous: input.isAnonymous ?? false,
      receiptOption: input.receiptOption,
      note: normalizeNote(input.note),
      nextChargeAt,
      amountTwd: line.subtotalTwd,
    },
    line,
  )

  emitOrderCreatedAudit(deps.logger, order.id, 'DONATION_PROJECT', order.lines.length)
  return order
}

// ── §4.3 createSaleItemPurchase ────────────────────────────────────────────

export async function createSaleItemPurchase(
  deps: OrderServiceDeps,
  input: SaleItemPurchaseBodyT,
): Promise<HydratedOrder> {
  // Phase 1 schema enforces items.length === 1 (TypeBox min=max=1, spec 022
  // §4.3). The invariant assertion at commit time re-checks (§7.4).
  const itemInput = input.items[0]!

  const now = deps.clock()
  const saleItem = await deps.prisma.saleItem.findFirst({
    where: { id: itemInput.saleItemId, ...whereLiveWithParent(now) },
    select: { id: true, priceTwd: true },
  })
  if (!saleItem) {
    throw new NotFoundError({
      resource: 'sale_item',
      id: itemInput.saleItemId,
      code: 'SALE_ITEM_NOT_FOUND',
    })
  }

  const line = buildSaleItemPurchaseLine({
    saleItemId: saleItem.id,
    quantity: itemInput.quantity,
    snapshotPriceTwd: saleItem.priceTwd,
  })

  const order = await persistOrderWithLine(
    deps,
    {
      donorName: input.donorName,
      isAnonymous: input.isAnonymous ?? false,
      // SALE_ITEM never carries a receiptOption (spec 021 §7.5 / IMG_4890).
      receiptOption: null,
      note: normalizeNote(input.note),
      nextChargeAt: null,
      amountTwd: line.subtotalTwd,
    },
    line,
  )

  emitOrderCreatedAudit(deps.logger, order.id, 'SALE_ITEM', order.lines.length)
  return order
}
