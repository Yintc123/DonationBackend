// Spec 020 §5.2 — DonationProject admin write endpoints (POST + PATCH +
// 4 lifecycle via shared helper).
// Spec 026 §5.2 — DonationProject admin read endpoints (list + detail).

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

import { parseCategoryKey } from '../../../domain/category/keys.js'
import { createProject, updateProject } from '../../../domain/donation-item/project-write.js'
import {
  getDonationProjectByIdForAdmin,
  listDonationProjectsForAdmin,
} from '../../../domain/donation-item/admin-read-services.js'
import { ErrorCode } from '../../../lib/errors/index.js'
import { paginatedEnvelope } from '../../../lib/http/index.js'
import { parseAcceptLanguage } from '../../../lib/i18n/index.js'
import { AdminProjectDetail } from '../../../schemas/donation-item/admin-detail.js'
import { AdminProjectListResponse } from '../../../schemas/donation-item/admin-list-item.js'
import { ProjectDetail } from '../../../schemas/donation-item/detail.js'
import {
  AdminListQueryWithCharityId,
  type AdminListQueryWithCharityT,
} from '../../../schemas/donation-item/shared.js'
import {
  ProjectCreateBody,
  ProjectPatchBody,
  type ProjectCreateBodyT,
  type ProjectPatchBodyT,
} from '../../../schemas/donation-item/project-write.js'

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

export async function registerProjectAdminRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /cms/donation/donation-projects (spec 026 §5.2.1) ────────────────
  app.route<{ Querystring: AdminListQueryWithCharityT }>({
    method: 'GET',
    url: '/donation/donation-projects',
    schema: {
      querystring: AdminListQueryWithCharityId,
      response: { 200: AdminProjectListResponse },
    },
    config: { rateLimit: READ_LIMITS },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const category = parseCategoryKey(req.query.category)
      const result = await listDonationProjectsForAdmin({
        prisma: app.prisma,
        locale,
        objectUrl: app.objectUrl,
        input: { ...req.query, category },
      })
      setAdminResponseHeaders(reply, locale)
      return paginatedEnvelope(result)
    },
  })

  // ── GET /cms/donation/donation-projects/:id (spec 026 §5.2.2) ────────────
  app.route<{ Params: IdParamsT }>({
    method: 'GET',
    url: '/donation/donation-projects/:id',
    schema: { params: IdParams, response: { 200: AdminProjectDetail } },
    config: { rateLimit: READ_LIMITS },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await getDonationProjectByIdForAdmin({
        prisma: app.prisma,
        locale,
        objectUrl: app.objectUrl,
        id: req.params.id,
      })
      setAdminResponseHeaders(reply, locale)
      return body
    },
  })

  app.route<{ Body: ProjectCreateBodyT }>({
    method: 'POST',
    url: '/donation/donation-projects',
    schema: { body: ProjectCreateBody, response: { 201: ProjectDetail } },
    config: { rateLimit: CREATE_LIMITS },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await createProject(
        { prisma: app.prisma, redis: app.redis, logger: req.log, locale, objectUrl: app.objectUrl },
        req.body,
      )
      return reply.created(`/cms/donation/donation-projects/${body.id}`, body)
    },
  })

  app.route<{ Params: IdParamsT; Body: ProjectPatchBodyT }>({
    method: 'PATCH',
    url: '/donation/donation-projects/:id',
    schema: { params: IdParams, body: ProjectPatchBody, response: { 200: ProjectDetail } },
    config: { rateLimit: UPDATE_LIMITS },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await updateProject(
        { prisma: app.prisma, redis: app.redis, logger: req.log, locale, objectUrl: app.objectUrl },
        req.params.id,
        req.body,
      )
      return reply.ok(body)
    },
  })

  registerLifecycleRoutes({
    app,
    basePath: '/donation/donation-projects',
    delegate: app.prisma.donationProject,
    entity: 'project',
    notFoundResource: 'donation-project',
    notFoundCode: ErrorCode.DONATION_PROJECT_NOT_FOUND,
    auditPrefix: 'donation_project',
    rateLimit: LIFECYCLE_LIMITS,
    // Spec 020 §8.1 cascading invalidation needs parent charityId for the
    // proj:list cache slot scoped to (charity, ALL).
    loadParent: async (delegate, id) => {
      const row = await delegate.findUnique({
        where: { id },
        select: { id: true, charityId: true },
      })
      return row === null ? null : { parentCharityId: row.charityId }
    },
  })
}
