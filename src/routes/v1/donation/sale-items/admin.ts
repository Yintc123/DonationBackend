// Spec 020 §5.3 — SaleItem admin endpoints (POST create + PATCH + 4 lifecycle).

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

import { createSaleItem, updateSaleItem } from '../../../../domain/donation-item/sale-item-write.js'
import { requireAdmin } from '../../../../lib/auth/index.js'
import { ErrorCode } from '../../../../lib/errors/index.js'
import { parseAcceptLanguage } from '../../../../lib/i18n/index.js'
import { SaleItemDetail } from '../../../../schemas/donation-item/detail.js'
import {
  SaleItemCreateBody,
  SaleItemPatchBody,
  type SaleItemCreateBodyT,
  type SaleItemPatchBodyT,
} from '../../../../schemas/donation-item/sale-item-write.js'

import { registerLifecycleRoutes } from '../lifecycle-routes-helper.js'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const IdParams = Type.Object({ id: Type.String({ pattern: UUID_V4_PATTERN }) })
type IdParamsT = Static<typeof IdParams>

const HOUR = 60 * 60 * 1000
const CREATE_LIMITS = { perUser: { limit: 60, windowMs: HOUR }, perIp: { limit: 300, windowMs: HOUR } }
const UPDATE_LIMITS = { perUser: { limit: 120, windowMs: HOUR }, perIp: { limit: 600, windowMs: HOUR } }
const LIFECYCLE_LIMITS = { perUser: { limit: 60, windowMs: HOUR }, perIp: { limit: 300, windowMs: HOUR } }

export async function registerSaleItemAdminRoutes(app: FastifyInstance): Promise<void> {
  app.route<{ Body: SaleItemCreateBodyT }>({
    method: 'POST',
    url: '/donation/sale-items',
    schema: { body: SaleItemCreateBody, response: { 201: SaleItemDetail } },
    config: { rateLimit: CREATE_LIMITS },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await createSaleItem(
        { prisma: app.prisma, redis: app.redis, logger: req.log, locale, objectUrl: app.objectUrl },
        req.body,
      )
      return reply.created(`/v1/donation/sale-items/${body.id}`, body)
    },
  })

  app.route<{ Params: IdParamsT; Body: SaleItemPatchBodyT }>({
    method: 'PATCH',
    url: '/donation/sale-items/:id',
    schema: { params: IdParams, body: SaleItemPatchBody, response: { 200: SaleItemDetail } },
    config: { rateLimit: UPDATE_LIMITS },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
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
