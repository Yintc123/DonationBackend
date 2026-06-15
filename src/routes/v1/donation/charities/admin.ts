// Spec 020 §5.1 — Charity admin endpoints.
//
// Six routes share one file (rather than one route per file) because they
// all wire to the same write-service module and share auth / rate-limit
// configuration. Splitting buys nothing on file-size and costs cross-file
// jumping for reviewers.

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

import { createCharity, updateCharity } from '../../../../domain/donation-item/charity-write.js'
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
import { CharityDetail } from '../../../../schemas/donation-item/detail.js'
import {
  CharityCreateBody,
  CharityPatchBody,
  type CharityCreateBodyT,
  type CharityPatchBodyT,
} from '../../../../schemas/donation-item/charity-write.js'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const IdParams = Type.Object({ id: Type.String({ pattern: UUID_V4_PATTERN }) })
type IdParamsT = Static<typeof IdParams>

// Spec 020 §11 rate-limit buckets — per-user limits already enforced by the
// shared `requireAdmin` (which returns the accountId, but the rate-limit
// plugin reads request.ip; per-user buckets need a custom key extractor
// which we defer to the spec 010 framework's future enhancement). For now
// per-IP is the operative gate.
const CREATE_PURPOSE = { name: 'donation-write-create', limit: 60, windowMs: 60 * 60 * 1000 }
const UPDATE_PURPOSE = { name: 'donation-write-update', limit: 120, windowMs: 60 * 60 * 1000 }
const LIFECYCLE_PURPOSE = {
  name: 'donation-write-lifecycle',
  limit: 60,
  windowMs: 60 * 60 * 1000,
}

export async function registerCharityAdminRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /v1/donation/charities (spec 020 §5.1.1) ───────────────────────
  app.route<{ Body: CharityCreateBodyT }>({
    method: 'POST',
    url: '/v1/donation/charities',
    schema: {
      body: CharityCreateBody,
      response: { 201: CharityDetail },
    },
    config: { rateLimit: { purposes: [CREATE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await createCharity(
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
      return reply.created(`/v1/donation/charities/${body.id}`, body)
    },
  })

  // ── PATCH /v1/donation/charities/:id (spec 020 §5.1.2) ──────────────────
  app.route<{ Params: IdParamsT; Body: CharityPatchBodyT }>({
    method: 'PATCH',
    url: '/v1/donation/charities/:id',
    schema: {
      params: IdParams,
      body: CharityPatchBody,
      response: { 200: CharityDetail },
    },
    config: { rateLimit: { purposes: [UPDATE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await updateCharity(
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

  // ── POST /v1/donation/charities/:id/archive (spec 020 §5.1.3) ───────────
  app.route<{ Params: IdParamsT }>({
    method: 'POST',
    url: '/v1/donation/charities/:id/archive',
    schema: { params: IdParams },
    config: { rateLimit: { purposes: [LIFECYCLE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const id = req.params.id
      // Differentiate 404 (row missing) from no-op (already in target state).
      if (!(await lifecycleExists(app.prisma.charity, id))) {
        throw new NotFoundError({ resource: 'charity', id, code: ErrorCode.CHARITY_NOT_FOUND })
      }
      await lifecycleArchive(
        app.prisma.charity,
        { redis: app.redis, logger: req.log, now: app.clock() },
        { entity: 'charity', id, auditEvent: 'donation_charity_archived' },
      )
      return reply.noContent()
    },
  })

  // ── POST /v1/donation/charities/:id/unarchive (spec 020 §5.1.4) ─────────
  app.route<{ Params: IdParamsT }>({
    method: 'POST',
    url: '/v1/donation/charities/:id/unarchive',
    schema: { params: IdParams },
    config: { rateLimit: { purposes: [LIFECYCLE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const id = req.params.id
      if (!(await lifecycleExists(app.prisma.charity, id))) {
        throw new NotFoundError({ resource: 'charity', id, code: ErrorCode.CHARITY_NOT_FOUND })
      }
      await lifecycleUnarchive(
        app.prisma.charity,
        { redis: app.redis, logger: req.log, now: app.clock() },
        { entity: 'charity', id, auditEvent: 'donation_charity_unarchived' },
      )
      return reply.noContent()
    },
  })

  // ── DELETE /v1/donation/charities/:id (spec 020 §5.1.5) ─────────────────
  app.route<{ Params: IdParamsT }>({
    method: 'DELETE',
    url: '/v1/donation/charities/:id',
    schema: { params: IdParams },
    config: { rateLimit: { purposes: [LIFECYCLE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const id = req.params.id
      if (!(await lifecycleExists(app.prisma.charity, id))) {
        throw new NotFoundError({ resource: 'charity', id, code: ErrorCode.CHARITY_NOT_FOUND })
      }
      await lifecycleSoftDelete(
        app.prisma.charity,
        { redis: app.redis, logger: req.log, now: app.clock() },
        { entity: 'charity', id, auditEvent: 'donation_charity_deleted' },
      )
      return reply.noContent()
    },
  })

  // ── POST /v1/donation/charities/:id/restore (spec 020 §5.1.6) ───────────
  app.route<{ Params: IdParamsT }>({
    method: 'POST',
    url: '/v1/donation/charities/:id/restore',
    schema: { params: IdParams },
    config: { rateLimit: { purposes: [LIFECYCLE_PURPOSE] } },
    handler: async (req, reply) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
      const id = req.params.id
      if (!(await lifecycleExists(app.prisma.charity, id))) {
        throw new NotFoundError({ resource: 'charity', id, code: ErrorCode.CHARITY_NOT_FOUND })
      }
      await lifecycleRestore(
        app.prisma.charity,
        { redis: app.redis, logger: req.log, now: app.clock() },
        { entity: 'charity', id, auditEvent: 'donation_charity_restored' },
      )
      return reply.noContent()
    },
  })
}
