// Spec 020 §5.1 — Charity admin write endpoints.
// Spec 026 §5.1 — Charity admin read endpoints (list + detail).
//
// Two write handlers (POST create + PATCH update) live here; the four
// lifecycle actions (archive / unarchive / DELETE soft / restore) go
// through the shared `registerLifecycleRoutes` helper. Spec 026 adds two
// reads (GET list + GET :id) that bypass Redis (`no-store, private`) and
// expose the lifecycle metadata public reads strip out.

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

import { parseCategoryKey } from '../../../domain/category/keys.js'
import { createCharity, updateCharity } from '../../../domain/donation-item/charity-write.js'
import {
  getCharityByIdForAdmin,
  listCharitiesForAdmin,
} from '../../../domain/donation-item/admin-read-services.js'
import { ErrorCode } from '../../../lib/errors/index.js'
import { paginatedEnvelope } from '../../../lib/http/index.js'
import { parseAcceptLanguage } from '../../../lib/i18n/index.js'
import { AdminCharityDetail } from '../../../schemas/donation-item/admin-detail.js'
import { AdminCharityListResponse } from '../../../schemas/donation-item/admin-list-item.js'
import { CharityDetail } from '../../../schemas/donation-item/detail.js'
import {
  AdminListQuery,
  type AdminListQueryT,
} from '../../../schemas/donation-item/shared.js'
import {
  CharityCreateBody,
  CharityPatchBody,
  type CharityCreateBodyT,
  type CharityPatchBodyT,
} from '../../../schemas/donation-item/charity-write.js'

import { setAdminResponseHeaders } from '../headers.js'
import { registerLifecycleRoutes } from '../lifecycle-routes-helper.js'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const IdParams = Type.Object({ id: Type.String({ pattern: UUID_V4_PATTERN }) })
type IdParamsT = Static<typeof IdParams>

// Spec 020 §11 — admin write dual-layer (per-user + per-IP).
// Spec 026 §7.2 — admin read uses a separate, looser limit family.
const HOUR = 60 * 60 * 1000
const CREATE_LIMITS = { perUser: { limit: 60, windowMs: HOUR }, perIp: { limit: 300, windowMs: HOUR } }
const UPDATE_LIMITS = { perUser: { limit: 120, windowMs: HOUR }, perIp: { limit: 600, windowMs: HOUR } }
const LIFECYCLE_LIMITS = { perUser: { limit: 60, windowMs: HOUR }, perIp: { limit: 300, windowMs: HOUR } }
const READ_LIMITS = { perUser: { limit: 600, windowMs: HOUR }, perIp: { limit: 3000, windowMs: HOUR } }

export async function registerCharityAdminRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /cms/donation/charities (spec 026 §5.1.1) ────────────────────────
  app.route<{ Querystring: AdminListQueryT }>({
    method: 'GET',
    url: '/donation/charities',
    schema: { querystring: AdminListQuery, response: { 200: AdminCharityListResponse } },
    config: { rateLimit: READ_LIMITS },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const category = parseCategoryKey(req.query.category)
      const result = await listCharitiesForAdmin({
        prisma: app.prisma,
        locale,
        objectUrl: app.objectUrl,
        input: { ...req.query, category },
      })
      setAdminResponseHeaders(reply, locale)
      return paginatedEnvelope(result)
    },
  })

  // ── GET /cms/donation/charities/:id (spec 026 §5.1.2) ────────────────────
  app.route<{ Params: IdParamsT }>({
    method: 'GET',
    url: '/donation/charities/:id',
    schema: { params: IdParams, response: { 200: AdminCharityDetail } },
    config: { rateLimit: READ_LIMITS },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await getCharityByIdForAdmin({
        prisma: app.prisma,
        locale,
        objectUrl: app.objectUrl,
        id: req.params.id,
      })
      setAdminResponseHeaders(reply, locale)
      return body
    },
  })

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
