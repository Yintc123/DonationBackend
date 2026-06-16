// Spec 022 §4.7-§4.10 — admin order endpoints.
//
// Every route is gated by `requireAdmin` (spec 020 §2.3): valid access JWT,
// account not disabled, claims.role === Role.ADMIN. Failures → 401 / 403
// before any service code runs. We thread the resolved `accountId` into the
// admin services so audit payloads can attribute the actor.

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

import {
  deleteOrderAsAdmin,
  listOrdersForAdmin,
  patchOrderAsAdmin,
} from '../../../../domain/order/admin-services.js'
import { normalizeNote } from '../../../../domain/order/normalize.js'
import { getOrderByIdOrFail } from '../../../../domain/order/query-services.js'
import { serializeOrder } from '../../../../domain/order/serialize.js'
import { requireAdmin } from '../../../../lib/auth/index.js'
import { paginatedSchema } from '../../../../lib/http/index.js'
import {
  AdminListQuery,
  AdminPatchBody,
  type AdminListQueryT,
  type AdminPatchBodyT,
} from '../../../../schemas/order/admin.js'
import { OrderResponse } from '../../../../schemas/order/response.js'
import type { TokenSecrets } from '../../../../lib/auth/index.js'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const OrderIdParams = Type.Object({
  id: Type.String({ pattern: UUID_V4_PATTERN }),
})
type OrderIdParamsT = Static<typeof OrderIdParams>

// spec 022 §8.2 — admin endpoints dual-layer (per-user + per-IP).
const HOUR = 60 * 60 * 1000
const ADMIN_LIST_LIMITS = {
  perUser: { limit: 600, windowMs: HOUR },
  perIp: { limit: 1200, windowMs: HOUR },
}
const ADMIN_DETAIL_LIMITS = {
  perUser: { limit: 1200, windowMs: HOUR },
  perIp: { limit: 2400, windowMs: HOUR },
}
const ADMIN_WRITE_LIMITS = {
  perUser: { limit: 60, windowMs: HOUR },
  perIp: { limit: 300, windowMs: HOUR },
}

export async function registerAdminOrderRoutes(app: FastifyInstance): Promise<void> {
  const tokenSecrets: TokenSecrets = app.tokenSecrets

  // ── GET /v1/admin/orders (spec 022 §4.7) ────────────────────────────────
  app.route<{ Querystring: AdminListQueryT }>({
    method: 'GET',
    url: '/admin/orders',
    schema: {
      querystring: AdminListQuery,
      response: { 200: paginatedSchema(OrderResponse) },
    },
    config: { rateLimit: ADMIN_LIST_LIMITS },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, tokenSecrets)
      const q = req.query
      const result = await listOrdersForAdmin(
        { prisma: app.prisma },
        {
          status: q.status,
          subjectType: q.subjectType,
          charityId: q.charityId,
          donationProjectId: q.donationProjectId,
          saleItemId: q.saleItemId,
          isAnonymous: q.isAnonymous,
          receiptOption: q.receiptOption,
          dateFrom: q.dateFrom ? new Date(q.dateFrom) : undefined,
          dateTo: q.dateTo ? new Date(q.dateTo) : undefined,
          cursor: q.cursor,
          limit: q.limit,
        },
      )
      return reply.paginated({
        items: result.items.map((o) => serializeOrder(o, app.objectUrl)),
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      })
    },
  })

  // ── GET /v1/admin/orders/:id (spec 022 §4.8) ────────────────────────────
  app.route<{ Params: OrderIdParamsT }>({
    method: 'GET',
    url: '/admin/orders/:id',
    schema: {
      params: OrderIdParams,
      response: { 200: OrderResponse },
    },
    config: { rateLimit: ADMIN_DETAIL_LIMITS },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, tokenSecrets)
      const order = await getOrderByIdOrFail({ prisma: app.prisma }, req.params.id)
      return reply.ok(serializeOrder(order, app.objectUrl))
    },
  })

  // ── PATCH /v1/admin/orders/:id (spec 022 §4.9) ──────────────────────────
  app.route<{ Params: OrderIdParamsT; Body: AdminPatchBodyT }>({
    method: 'PATCH',
    url: '/admin/orders/:id',
    schema: {
      params: OrderIdParams,
      body: AdminPatchBody,
      response: { 200: OrderResponse },
    },
    config: { rateLimit: ADMIN_WRITE_LIMITS },
    handler: async (req, reply) => {
      const accountId = await requireAdmin(req, app.prisma, tokenSecrets)
      const body = req.body
      const order = await patchOrderAsAdmin(
        { prisma: app.prisma, logger: req.log },
        accountId,
        req.params.id,
        {
          status: body.status,
          donorName: body.donorName,
          isAnonymous: body.isAnonymous,
          note: normalizeNote(body.note),
          receiptOption: body.receiptOption,
          paidAt:
            body.paidAt === undefined ? undefined : body.paidAt === null ? null : new Date(body.paidAt),
          cancelledAt:
            body.cancelledAt === undefined
              ? undefined
              : body.cancelledAt === null
                ? null
                : new Date(body.cancelledAt),
        },
      )
      return reply.ok(serializeOrder(order, app.objectUrl))
    },
  })

  // ── DELETE /v1/admin/orders/:id (spec 022 §4.10) ────────────────────────
  app.route<{ Params: OrderIdParamsT }>({
    method: 'DELETE',
    url: '/admin/orders/:id',
    schema: {
      params: OrderIdParams,
    },
    config: { rateLimit: ADMIN_WRITE_LIMITS },
    handler: async (req, reply) => {
      const accountId = await requireAdmin(req, app.prisma, tokenSecrets)
      await deleteOrderAsAdmin(
        { prisma: app.prisma, logger: req.log },
        accountId,
        req.params.id,
      )
      return reply.noContent()
    },
  })
}
