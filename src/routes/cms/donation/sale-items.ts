// Spec 020 §5.3 — SaleItem admin write endpoints (POST + PATCH + 4 lifecycle).
// Spec 026 §5.3 — SaleItem admin read endpoints (list + detail).

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

import { parseCategoryKey } from '../../../domain/category/keys.js'
import { createSaleItem, updateSaleItem } from '../../../domain/donation-item/sale-item-write.js'
import {
  getSaleItemByIdForAdmin,
  listSaleItemsForAdmin,
} from '../../../domain/donation-item/admin-read-services.js'
import { ErrorCode } from '../../../lib/errors/index.js'
import { paginatedEnvelope } from '../../../lib/http/index.js'
import { parseAcceptLanguage } from '../../../lib/i18n/index.js'
import { AdminSaleItemDetail } from '../../../schemas/donation-item/admin-detail.js'
import { AdminSaleItemListResponse } from '../../../schemas/donation-item/admin-list-item.js'
import { SaleItemDetail } from '../../../schemas/donation-item/detail.js'
import {
  AdminListQueryWithCharityId,
  type AdminListQueryWithCharityT,
} from '../../../schemas/donation-item/shared.js'
import {
  SaleItemCreateBody,
  SaleItemPatchBody,
  type SaleItemCreateBodyT,
  type SaleItemPatchBodyT,
} from '../../../schemas/donation-item/sale-item-write.js'

import { setAdminResponseHeaders } from '../headers.js'
import { registerLifecycleRoutes } from '../lifecycle-routes-helper.js'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const IdParams = Type.Object({ id: Type.String({ pattern: UUID_V4_PATTERN }) })
type IdParamsT = Static<typeof IdParams>

const HOUR = 60 * 60 * 1000
const CREATE_LIMITS = { perUser: { limit: 60, windowMs: HOUR }, perIp: { limit: 300, windowMs: HOUR } }
const UPDATE_LIMITS = { perUser: { limit: 120, windowMs: HOUR }, perIp: { limit: 600, windowMs: HOUR } }
const LIFECYCLE_LIMITS = { perUser: { limit: 60, windowMs: HOUR }, perIp: { limit: 300, windowMs: HOUR } }
const READ_LIMITS = { perUser: { limit: 600, windowMs: HOUR }, perIp: { limit: 3000, windowMs: HOUR } }

export async function registerSaleItemAdminRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /cms/donation/sale-items (spec 026 §5.3.1) ───────────────────────
  app.route<{ Querystring: AdminListQueryWithCharityT }>({
    method: 'GET',
    url: '/donation/sale-items',
    schema: {
      querystring: AdminListQueryWithCharityId,
      response: { 200: AdminSaleItemListResponse },
    },
    config: { rateLimit: READ_LIMITS },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const category = parseCategoryKey(req.query.category)
      const result = await listSaleItemsForAdmin({
        prisma: app.prisma,
        locale,
        objectUrl: app.objectUrl,
        input: { ...req.query, category },
      })
      setAdminResponseHeaders(reply, locale)
      return paginatedEnvelope(result)
    },
  })

  // ── GET /cms/donation/sale-items/:id (spec 026 §5.3.2) ───────────────────
  app.route<{ Params: IdParamsT }>({
    method: 'GET',
    url: '/donation/sale-items/:id',
    schema: { params: IdParams, response: { 200: AdminSaleItemDetail } },
    config: { rateLimit: READ_LIMITS },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await getSaleItemByIdForAdmin({
        prisma: app.prisma,
        locale,
        objectUrl: app.objectUrl,
        id: req.params.id,
      })
      setAdminResponseHeaders(reply, locale)
      return body
    },
  })

  app.route<{ Body: SaleItemCreateBodyT }>({
    method: 'POST',
    url: '/donation/sale-items',
    schema: { body: SaleItemCreateBody, response: { 201: SaleItemDetail } },
    config: { rateLimit: CREATE_LIMITS },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await createSaleItem(
        { prisma: app.prisma, redis: app.redis, logger: req.log, locale, objectUrl: app.objectUrl },
        req.body,
      )
      return reply.created(`/cms/donation/sale-items/${body.id}`, body)
    },
  })

  app.route<{ Params: IdParamsT; Body: SaleItemPatchBodyT }>({
    method: 'PATCH',
    url: '/donation/sale-items/:id',
    schema: { params: IdParams, body: SaleItemPatchBody, response: { 200: SaleItemDetail } },
    config: { rateLimit: UPDATE_LIMITS },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await updateSaleItem(
        { prisma: app.prisma, redis: app.redis, logger: req.log, locale, objectUrl: app.objectUrl },
        req.params.id,
        req.body,
      )
      return reply.ok(body)
    },
  })

  registerLifecycleRoutes({
    app,
    basePath: '/donation/sale-items',
    delegate: app.prisma.saleItem,
    entity: 'sale',
    notFoundResource: 'sale-item',
    notFoundCode: ErrorCode.SALE_ITEM_NOT_FOUND,
    auditPrefix: 'donation_sale',
    rateLimit: LIFECYCLE_LIMITS,
    loadParent: async (delegate, id) => {
      const row = await delegate.findUnique({
        where: { id },
        select: { id: true, charityId: true },
      })
      return row === null ? null : { parentCharityId: row.charityId }
    },
  })
}
