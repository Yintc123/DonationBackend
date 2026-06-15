// Spec 020 §5.3 — SaleItem admin endpoints (6).

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

import { createSaleItem, updateSaleItem } from '../../../../domain/donation-item/sale-item-write.js'
import {
  archive as lifecycleArchive,
  exists as lifecycleExists,
  restore as lifecycleRestore,
  softDelete as lifecycleSoftDelete,
  unarchive as lifecycleUnarchive,
} from '../../../../domain/donation-item/lifecycle-actions.js'
import { requireAdmin } from '../../../../lib/auth/index.js'
import { ErrorCode, NotFoundError } from '../../../../lib/errors/index.js'
import { parseAcceptLanguage } from '../../../../lib/i18n/index.js'
import { SaleItemDetail } from '../../../../schemas/donation-item/detail.js'
import {
  SaleItemCreateBody,
  SaleItemPatchBody,
  type SaleItemCreateBodyT,
  type SaleItemPatchBodyT,
} from '../../../../schemas/donation-item/sale-item-write.js'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const IdParams = Type.Object({ id: Type.String({ pattern: UUID_V4_PATTERN }) })
type IdParamsT = Static<typeof IdParams>

const CREATE_PURPOSE = { name: 'donation-write-create', limit: 60, windowMs: 60 * 60 * 1000 }
const UPDATE_PURPOSE = { name: 'donation-write-update', limit: 120, windowMs: 60 * 60 * 1000 }
const LIFECYCLE_PURPOSE = {
  name: 'donation-write-lifecycle',
  limit: 60,
  windowMs: 60 * 60 * 1000,
}

async function requireExisting(app: FastifyInstance, id: string): Promise<string> {
  if (!(await lifecycleExists(app.prisma.saleItem, id))) {
    throw new NotFoundError({ resource: 'sale-item', id, code: ErrorCode.SALE_ITEM_NOT_FOUND })
  }
  const row = await app.prisma.saleItem.findUnique({
    where: { id },
    select: { charityId: true },
  })
  return row!.charityId
}

export async function registerSaleItemAdminRoutes(app: FastifyInstance): Promise<void> {
  app.route<{ Body: SaleItemCreateBodyT }>({
    method: 'POST',
    url: '/v1/donation/sale-items',
    schema: { body: SaleItemCreateBody, response: { 201: SaleItemDetail } },
    config: { rateLimit: { purposes: [CREATE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await createSaleItem(
        {
          prisma: app.prisma,
          redis: app.redis,
          logger: req.log,
          clock: app.clock,
          locale,
          objectUrl: app.objectUrl,
        },
        req.body,
      )
      return reply.created(`/v1/donation/sale-items/${body.id}`, body)
    },
  })

  app.route<{ Params: IdParamsT; Body: SaleItemPatchBodyT }>({
    method: 'PATCH',
    url: '/v1/donation/sale-items/:id',
    schema: { params: IdParams, body: SaleItemPatchBody, response: { 200: SaleItemDetail } },
    config: { rateLimit: { purposes: [UPDATE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await updateSaleItem(
        {
          prisma: app.prisma,
          redis: app.redis,
          logger: req.log,
          clock: app.clock,
          locale,
          objectUrl: app.objectUrl,
        },
        req.params.id,
        req.body,
      )
      return reply.ok(body)
    },
  })

  app.route<{ Params: IdParamsT }>({
    method: 'POST',
    url: '/v1/donation/sale-items/:id/archive',
    schema: { params: IdParams },
    config: { rateLimit: { purposes: [LIFECYCLE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const id = req.params.id
      const parentCharityId = await requireExisting(app, id)
      await lifecycleArchive(
        app.prisma.saleItem,
        { redis: app.redis, logger: req.log, now: app.clock() },
        { entity: 'sale', id, parentCharityId, auditEvent: 'donation_sale_archived' },
      )
      return reply.noContent()
    },
  })

  app.route<{ Params: IdParamsT }>({
    method: 'POST',
    url: '/v1/donation/sale-items/:id/unarchive',
    schema: { params: IdParams },
    config: { rateLimit: { purposes: [LIFECYCLE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const id = req.params.id
      const parentCharityId = await requireExisting(app, id)
      await lifecycleUnarchive(
        app.prisma.saleItem,
        { redis: app.redis, logger: req.log, now: app.clock() },
        { entity: 'sale', id, parentCharityId, auditEvent: 'donation_sale_unarchived' },
      )
      return reply.noContent()
    },
  })

  app.route<{ Params: IdParamsT }>({
    method: 'DELETE',
    url: '/v1/donation/sale-items/:id',
    schema: { params: IdParams },
    config: { rateLimit: { purposes: [LIFECYCLE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const id = req.params.id
      const parentCharityId = await requireExisting(app, id)
      await lifecycleSoftDelete(
        app.prisma.saleItem,
        { redis: app.redis, logger: req.log, now: app.clock() },
        { entity: 'sale', id, parentCharityId, auditEvent: 'donation_sale_deleted' },
      )
      return reply.noContent()
    },
  })

  app.route<{ Params: IdParamsT }>({
    method: 'POST',
    url: '/v1/donation/sale-items/:id/restore',
    schema: { params: IdParams },
    config: { rateLimit: { purposes: [LIFECYCLE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const id = req.params.id
      const parentCharityId = await requireExisting(app, id)
      await lifecycleRestore(
        app.prisma.saleItem,
        { redis: app.redis, logger: req.log, now: app.clock() },
        { entity: 'sale', id, parentCharityId, auditEvent: 'donation_sale_restored' },
      )
      return reply.noContent()
    },
  })
}
