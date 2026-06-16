// Spec 020 §5.1 — Charity admin endpoints.
//
// Two handlers (POST create + PATCH update) live here; the four lifecycle
// actions (archive / unarchive / DELETE soft / restore) go through the
// shared `registerLifecycleRoutes` helper.

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

import { createCharity, updateCharity } from '../../../../domain/donation-item/charity-write.js'
import { ErrorCode } from '../../../../lib/errors/index.js'
import { parseAcceptLanguage } from '../../../../lib/i18n/index.js'
import { CharityDetail } from '../../../../schemas/donation-item/detail.js'
import {
  CharityCreateBody,
  CharityPatchBody,
  type CharityCreateBodyT,
  type CharityPatchBodyT,
} from '../../../../schemas/donation-item/charity-write.js'

import { registerLifecycleRoutes } from '../lifecycle-routes-helper.js'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const IdParams = Type.Object({ id: Type.String({ pattern: UUID_V4_PATTERN }) })
type IdParamsT = Static<typeof IdParams>

// Spec 020 §11 — admin write dual-layer (per-user + per-IP).
const HOUR = 60 * 60 * 1000
const CREATE_LIMITS = { perUser: { limit: 60, windowMs: HOUR }, perIp: { limit: 300, windowMs: HOUR } }
const UPDATE_LIMITS = { perUser: { limit: 120, windowMs: HOUR }, perIp: { limit: 600, windowMs: HOUR } }
const LIFECYCLE_LIMITS = { perUser: { limit: 60, windowMs: HOUR }, perIp: { limit: 300, windowMs: HOUR } }

export async function registerCharityAdminRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /cms/donation/charities (spec 020 §5.1.1) ───────────────────────
  app.route<{ Body: CharityCreateBodyT }>({
    method: 'POST',
    url: '/donation/charities',
    schema: { body: CharityCreateBody, response: { 201: CharityDetail } },
    config: { rateLimit: CREATE_LIMITS },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await createCharity(
        {
          prisma: app.prisma,
          redis: app.redis,
          logger: req.log,
          locale,
          objectUrl: app.objectUrl,
        },
        req.body,
      )
      return reply.created(`/cms/donation/charities/${body.id}`, body)
    },
  })

  // ── PATCH /cms/donation/charities/:id (spec 020 §5.1.2) ──────────────────
  app.route<{ Params: IdParamsT; Body: CharityPatchBodyT }>({
    method: 'PATCH',
    url: '/donation/charities/:id',
    schema: { params: IdParams, body: CharityPatchBody, response: { 200: CharityDetail } },
    config: { rateLimit: UPDATE_LIMITS },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await updateCharity(
        {
          prisma: app.prisma,
          redis: app.redis,
          logger: req.log,
          locale,
          objectUrl: app.objectUrl,
        },
        req.params.id,
        req.body,
      )
      return reply.ok(body)
    },
  })

  // ── 4 lifecycle endpoints (spec 020 §5.1.3-§5.1.6) ──────────────────────
  registerLifecycleRoutes({
    app,
    basePath: '/donation/charities',
    delegate: app.prisma.charity,
    entity: 'charity',
    notFoundResource: 'charity',
    notFoundCode: ErrorCode.CHARITY_NOT_FOUND,
    auditPrefix: 'donation_charity',
    rateLimit: LIFECYCLE_LIMITS,
  })
}
