// Spec 020 §5.4 — Category admin endpoints (PATCH + 4 lifecycle; no create).

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

import { updateCategory } from '../../../../domain/category/write.js'
import { requireAdmin } from '../../../../lib/auth/index.js'
import { ErrorCode } from '../../../../lib/errors/index.js'
import { parseAcceptLanguage } from '../../../../lib/i18n/index.js'
import {
  CategoryAdminResponse,
  CategoryPatchBody,
  type CategoryPatchBodyT,
} from '../../../../schemas/category/admin.js'

import { registerLifecycleRoutes } from '../lifecycle-routes-helper.js'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const IdParams = Type.Object({ id: Type.String({ pattern: UUID_V4_PATTERN }) })
type IdParamsT = Static<typeof IdParams>

// Spec 020 §11 — Category lives in a tighter dual-layer bucket (dictionary
// table, edits are rare).
const HOUR = 60 * 60 * 1000
const CATEGORY_LIMITS = {
  perUser: { limit: 30, windowMs: HOUR },
  perIp: { limit: 100, windowMs: HOUR },
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
    config: { rateLimit: CATEGORY_LIMITS },
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

  registerLifecycleRoutes({
    app,
    basePath: '/v1/donation/categories',
    delegate: app.prisma.category,
    entity: 'category',
    notFoundResource: 'category',
    notFoundCode: ErrorCode.CATEGORY_NOT_FOUND,
    auditPrefix: 'donation_category',
    rateLimit: CATEGORY_LIMITS,
  })
}
