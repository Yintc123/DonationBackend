// Spec 020 §5.2 — DonationProject admin endpoints (6).

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

import { createProject, updateProject } from '../../../../domain/donation-item/project-write.js'
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
import { ProjectDetail } from '../../../../schemas/donation-item/detail.js'
import {
  ProjectCreateBody,
  ProjectPatchBody,
  type ProjectCreateBodyT,
  type ProjectPatchBodyT,
} from '../../../../schemas/donation-item/project-write.js'

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
  if (!(await lifecycleExists(app.prisma.donationProject, id))) {
    throw new NotFoundError({
      resource: 'donation-project',
      id,
      code: ErrorCode.DONATION_PROJECT_NOT_FOUND,
    })
  }
  const row = await app.prisma.donationProject.findUnique({
    where: { id },
    select: { charityId: true },
  })
  return row!.charityId
}

export async function registerProjectAdminRoutes(app: FastifyInstance): Promise<void> {
  app.route<{ Body: ProjectCreateBodyT }>({
    method: 'POST',
    url: '/v1/donation/donation-projects',
    schema: { body: ProjectCreateBody, response: { 201: ProjectDetail } },
    config: { rateLimit: { purposes: [CREATE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await createProject(
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
      return reply.created(`/v1/donation/donation-projects/${body.id}`, body)
    },
  })

  app.route<{ Params: IdParamsT; Body: ProjectPatchBodyT }>({
    method: 'PATCH',
    url: '/v1/donation/donation-projects/:id',
    schema: { params: IdParams, body: ProjectPatchBody, response: { 200: ProjectDetail } },
    config: { rateLimit: { purposes: [UPDATE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await updateProject(
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
    url: '/v1/donation/donation-projects/:id/archive',
    schema: { params: IdParams },
    config: { rateLimit: { purposes: [LIFECYCLE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const id = req.params.id
      const parentCharityId = await requireExisting(app, id)
      await lifecycleArchive(
        app.prisma.donationProject,
        { redis: app.redis, logger: req.log, now: app.clock() },
        { entity: 'project', id, parentCharityId, auditEvent: 'donation_project_archived' },
      )
      return reply.noContent()
    },
  })

  app.route<{ Params: IdParamsT }>({
    method: 'POST',
    url: '/v1/donation/donation-projects/:id/unarchive',
    schema: { params: IdParams },
    config: { rateLimit: { purposes: [LIFECYCLE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const id = req.params.id
      const parentCharityId = await requireExisting(app, id)
      await lifecycleUnarchive(
        app.prisma.donationProject,
        { redis: app.redis, logger: req.log, now: app.clock() },
        { entity: 'project', id, parentCharityId, auditEvent: 'donation_project_unarchived' },
      )
      return reply.noContent()
    },
  })

  app.route<{ Params: IdParamsT }>({
    method: 'DELETE',
    url: '/v1/donation/donation-projects/:id',
    schema: { params: IdParams },
    config: { rateLimit: { purposes: [LIFECYCLE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const id = req.params.id
      const parentCharityId = await requireExisting(app, id)
      await lifecycleSoftDelete(
        app.prisma.donationProject,
        { redis: app.redis, logger: req.log, now: app.clock() },
        { entity: 'project', id, parentCharityId, auditEvent: 'donation_project_deleted' },
      )
      return reply.noContent()
    },
  })

  app.route<{ Params: IdParamsT }>({
    method: 'POST',
    url: '/v1/donation/donation-projects/:id/restore',
    schema: { params: IdParams },
    config: { rateLimit: { purposes: [LIFECYCLE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const id = req.params.id
      const parentCharityId = await requireExisting(app, id)
      await lifecycleRestore(
        app.prisma.donationProject,
        { redis: app.redis, logger: req.log, now: app.clock() },
        { entity: 'project', id, parentCharityId, auditEvent: 'donation_project_restored' },
      )
      return reply.noContent()
    },
  })
}
