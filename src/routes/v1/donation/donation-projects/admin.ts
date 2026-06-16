// Spec 020 §5.2 — DonationProject admin endpoints (POST create + PATCH +
// 4 lifecycle via shared helper).

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

import { createProject, updateProject } from '../../../../domain/donation-item/project-write.js'
import { ErrorCode } from '../../../../lib/errors/index.js'
import { parseAcceptLanguage } from '../../../../lib/i18n/index.js'
import { ProjectDetail } from '../../../../schemas/donation-item/detail.js'
import {
  ProjectCreateBody,
  ProjectPatchBody,
  type ProjectCreateBodyT,
  type ProjectPatchBodyT,
} from '../../../../schemas/donation-item/project-write.js'

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

export async function registerProjectAdminRoutes(app: FastifyInstance): Promise<void> {
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
