// Spec 022 §4.1-§4.3 — POST routes for the three donation order creates.
//
// Phase 2 scope: the three create endpoints only. confirm-payment / cancel
// / GET detail / admin CRUD land in Phase 3.
//
// Each handler is intentionally thin: TypeBox validates the body, the
// service does the work (lookup → transaction → invariants), the
// serializer hands back a wire-format object. `reply.created(loc, body)`
// (spec 009 §3.1) sets Location + 201 in one call.

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

import { systemClock } from '../../../../lib/clock.js'
import {
  createCharityDonation,
  createProjectDonation,
  createSaleItemPurchase,
} from '../../../../domain/order/create-services.js'
import {
  cancelOrder,
  confirmPayment,
} from '../../../../domain/order/lifecycle-services.js'
import { getOrderByIdOrFail } from '../../../../domain/order/query-services.js'
import { serializeOrder } from '../../../../domain/order/serialize.js'
import {
  CharityDonationBody,
  ProjectDonationBody,
  SaleItemPurchaseBody,
  type CharityDonationBodyT,
  type ProjectDonationBodyT,
  type SaleItemPurchaseBodyT,
} from '../../../../schemas/order/body.js'
import { OrderResponse } from '../../../../schemas/order/response.js'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const OrderIdParams = Type.Object({
  id: Type.String({ pattern: UUID_V4_PATTERN }),
})
type OrderIdParamsT = Static<typeof OrderIdParams>

// Spec 022 §8.1 — per-IP rate limit purposes. The 3 create endpoints
// share one shared bucket so clients can't dodge by alternating between
// charity / project / sale-item. confirm + cancel share one bucket too —
// they're the two state-mutating actions a holder of orderId can take.
const ORDER_CREATE_PURPOSE = {
  name: 'order-create',
  limit: 30,
  windowMs: 60 * 60 * 1000,
}
const ORDER_LIFECYCLE_PURPOSE = {
  name: 'order-lifecycle',
  limit: 60,
  windowMs: 60 * 60 * 1000,
}
const ORDER_DETAIL_PURPOSE = {
  name: 'order-detail',
  limit: 300,
  windowMs: 60 * 60 * 1000,
}

export async function registerOrderRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /v1/donation/orders/charity-donation (spec 022 §4.1) ───────────
  app.route<{ Body: CharityDonationBodyT }>({
    method: 'POST',
    url: '/v1/donation/orders/charity-donation',
    schema: {
      body: CharityDonationBody,
      response: { 201: OrderResponse },
    },
    config: { rateLimit: { purposes: [ORDER_CREATE_PURPOSE] } },
    handler: async (req, reply) => {
      const order = await createCharityDonation(
        { prisma: app.prisma, clock: app.clock ?? systemClock, logger: req.log },
        req.body,
      )
      return reply.created(`/v1/donation/orders/${order.id}`, serializeOrder(order, app.objectUrl))
    },
  })

  // ── POST /v1/donation/orders/project-donation (spec 022 §4.2) ───────────
  app.route<{ Body: ProjectDonationBodyT }>({
    method: 'POST',
    url: '/v1/donation/orders/project-donation',
    schema: {
      body: ProjectDonationBody,
      response: { 201: OrderResponse },
    },
    config: { rateLimit: { purposes: [ORDER_CREATE_PURPOSE] } },
    handler: async (req, reply) => {
      const order = await createProjectDonation(
        { prisma: app.prisma, clock: app.clock ?? systemClock, logger: req.log },
        req.body,
      )
      return reply.created(`/v1/donation/orders/${order.id}`, serializeOrder(order, app.objectUrl))
    },
  })

  // ── POST /v1/donation/orders/sale-item-purchase (spec 022 §4.3) ─────────
  app.route<{ Body: SaleItemPurchaseBodyT }>({
    method: 'POST',
    url: '/v1/donation/orders/sale-item-purchase',
    schema: {
      body: SaleItemPurchaseBody,
      response: { 201: OrderResponse },
    },
    config: { rateLimit: { purposes: [ORDER_CREATE_PURPOSE] } },
    handler: async (req, reply) => {
      const order = await createSaleItemPurchase(
        { prisma: app.prisma, clock: app.clock ?? systemClock, logger: req.log },
        req.body,
      )
      return reply.created(`/v1/donation/orders/${order.id}`, serializeOrder(order, app.objectUrl))
    },
  })

  // ── GET /v1/donation/orders/:id (spec 022 §4.6) ─────────────────────────
  app.route<{ Params: OrderIdParamsT }>({
    method: 'GET',
    url: '/v1/donation/orders/:id',
    schema: {
      params: OrderIdParams,
      response: { 200: OrderResponse },
    },
    config: { rateLimit: { purposes: [ORDER_DETAIL_PURPOSE] } },
    handler: async (req, reply) => {
      const order = await getOrderByIdOrFail({ prisma: app.prisma }, req.params.id)
      return reply.ok(serializeOrder(order, app.objectUrl))
    },
  })

  // ── POST /v1/donation/orders/:id/confirm-payment (spec 022 §4.4) ────────
  app.route<{ Params: OrderIdParamsT }>({
    method: 'POST',
    url: '/v1/donation/orders/:id/confirm-payment',
    schema: {
      params: OrderIdParams,
      response: { 200: OrderResponse },
    },
    config: { rateLimit: { purposes: [ORDER_LIFECYCLE_PURPOSE] } },
    handler: async (req, reply) => {
      const order = await confirmPayment(
        { prisma: app.prisma, clock: app.clock ?? systemClock, logger: req.log },
        req.params.id,
      )
      return reply.ok(serializeOrder(order, app.objectUrl))
    },
  })

  // ── POST /v1/donation/orders/:id/cancel (spec 022 §4.5) ─────────────────
  app.route<{ Params: OrderIdParamsT }>({
    method: 'POST',
    url: '/v1/donation/orders/:id/cancel',
    schema: {
      params: OrderIdParams,
      response: { 200: OrderResponse },
    },
    config: { rateLimit: { purposes: [ORDER_LIFECYCLE_PURPOSE] } },
    handler: async (req, reply) => {
      const order = await cancelOrder(
        { prisma: app.prisma, clock: app.clock ?? systemClock, logger: req.log },
        req.params.id,
      )
      return reply.ok(serializeOrder(order, app.objectUrl))
    },
  })
}
