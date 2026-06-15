// Spec 020 §5.4 — Category admin endpoints (5 routes; no create).

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

import { updateCategory } from '../../../../domain/category/write.js'
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
import {
  CategoryAdminResponse,
  CategoryPatchBody,
  type CategoryPatchBodyT,
} from '../../../../schemas/category/admin.js'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const IdParams = Type.Object({ id: Type.String({ pattern: UUID_V4_PATTERN }) })
type IdParamsT = Static<typeof IdParams>

// Spec 020 §11 — Category lives in a tighter bucket than the other entities
// (dictionary table, edits are rare).
const CATEGORY_WRITE_PURPOSE = {
  name: 'donation-category-write',
  limit: 30,
  windowMs: 60 * 60 * 1000,
}

async function requireExisting(app: FastifyInstance, id: string): Promise<void> {
  if (!(await lifecycleExists(app.prisma.category, id))) {
    throw new NotFoundError({ resource: 'category', id, code: ErrorCode.NOT_FOUND })
  }
}

export async function registerCategoryAdminRoutes(app: FastifyInstance): Promise<void> {
  // ── PATCH /v1/donation/categories/:id (spec 020 §5.4.1) ─────────────────
  app.route<{ Params: IdParamsT; Body: CategoryPatchBodyT }>({
    method: 'PATCH',
    url: '/v1/donation/categories/:id',
    schema: {
      params: IdParams,
      body: CategoryPatchBody,
      response: { 200: CategoryAdminResponse },
    },
    config: { rateLimit: { purposes: [CATEGORY_WRITE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await updateCategory(
        { prisma: app.prisma, redis: app.redis, logger: req.log, locale },
        req.params.id,
        req.body,
      )
      return reply.ok(body)
    },
  })

  app.route<{ Params: IdParamsT }>({
    method: 'POST',
    url: '/v1/donation/categories/:id/archive',
    schema: { params: IdParams },
    config: { rateLimit: { purposes: [CATEGORY_WRITE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const id = req.params.id
      await requireExisting(app, id)
      await lifecycleArchive(
        app.prisma.category,
        { redis: app.redis, logger: req.log, now: app.clock() },
        { entity: 'category', id, auditEvent: 'donation_category_archived' },
      )
      return reply.noContent()
    },
  })

  app.route<{ Params: IdParamsT }>({
    method: 'POST',
    url: '/v1/donation/categories/:id/unarchive',
    schema: { params: IdParams },
    config: { rateLimit: { purposes: [CATEGORY_WRITE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const id = req.params.id
      await requireExisting(app, id)
      await lifecycleUnarchive(
        app.prisma.category,
        { redis: app.redis, logger: req.log, now: app.clock() },
        { entity: 'category', id, auditEvent: 'donation_category_unarchived' },
      )
      return reply.noContent()
    },
  })

  app.route<{ Params: IdParamsT }>({
    method: 'DELETE',
    url: '/v1/donation/categories/:id',
    schema: { params: IdParams },
    config: { rateLimit: { purposes: [CATEGORY_WRITE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const id = req.params.id
      await requireExisting(app, id)
      await lifecycleSoftDelete(
        app.prisma.category,
        { redis: app.redis, logger: req.log, now: app.clock() },
        { entity: 'category', id, auditEvent: 'donation_category_deleted' },
      )
      return reply.noContent()
    },
  })

  app.route<{ Params: IdParamsT }>({
    method: 'POST',
    url: '/v1/donation/categories/:id/restore',
    schema: { params: IdParams },
    config: { rateLimit: { purposes: [CATEGORY_WRITE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const id = req.params.id
      await requireExisting(app, id)
      await lifecycleRestore(
        app.prisma.category,
        { redis: app.redis, logger: req.log, now: app.clock() },
        { entity: 'category', id, auditEvent: 'donation_category_restored' },
      )
      return reply.noContent()
    },
  })
}
