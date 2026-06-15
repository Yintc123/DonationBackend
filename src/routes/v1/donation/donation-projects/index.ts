// Spec 016 §3 / spec 017 §4 — DonationProject list + detail.

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

import { paginatedEnvelope } from '../../../../lib/http/index.js'
import { parseAcceptLanguage } from '../../../../lib/i18n/index.js'
import { parseCategoryKey } from '../../../../domain/category/keys.js'
import { ProjectDetail } from '../../../../schemas/donation-item/detail.js'
import { ProjectListResponse } from '../../../../schemas/donation-item/list-item.js'
import {
  ListQueryWithCharityId,
  type ListQueryWithCharity,
} from '../../../../schemas/donation-item/shared.js'
import {
  getCachedDonationProjectById,
  listCachedDonationProjects,
} from '../../../../services/cached-donation-project.js'

import { sendDetail, setI18nHeaders, setNoCache } from '../headers.js'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const IdParams = Type.Object({
  id: Type.String({ pattern: UUID_V4_PATTERN }),
})
type IdParamsT = Static<typeof IdParams>

export async function registerDonationProjectRoutes(app: FastifyInstance): Promise<void> {
  app.route<{ Querystring: ListQueryWithCharity }>({
    method: 'GET',
    url: '/v1/donation/donation-projects',
    schema: {
      querystring: ListQueryWithCharityId,
      response: { 200: ProjectListResponse },
    },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const category = parseCategoryKey(req.query.category)
      const result = await listCachedDonationProjects({
        prisma: app.prisma,
        redis: app.redis,
        logger: req.log,
        now: app.clock(),
        locale,
        objectUrl: app.objectUrl,
        input: { ...req.query, category },
      })
      setI18nHeaders(reply, locale)
      setNoCache(reply)
      return paginatedEnvelope(result)
    },
  })

  app.route<{ Params: IdParamsT }>({
    method: 'GET',
    url: '/v1/donation/donation-projects/:id',
    schema: {
      params: IdParams,
      response: { 200: ProjectDetail },
    },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const result = await getCachedDonationProjectById({
        prisma: app.prisma,
        redis: app.redis,
        logger: req.log,
        now: app.clock(),
        locale,
        objectUrl: app.objectUrl,
        id: req.params.id,
      })
      return sendDetail(req, reply, locale, result)
    },
  })
}
