// Spec 016 §3 / spec 017 §3 — Charity list + detail.

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

import { paginatedEnvelope } from '../../../../lib/http/index.js'
import { parseAcceptLanguage } from '../../../../lib/i18n/index.js'
import {
  getCharityById,
  listCharities,
} from '../../../../domain/donation-item/index.js'
import {
  CharityDetail,
} from '../../../../schemas/donation-item/detail.js'
import {
  CharityListResponse,
} from '../../../../schemas/donation-item/list-item.js'
import { ListQueryBase, type ListQuery } from '../../../../schemas/donation-item/shared.js'

import { sendDetail, setI18nHeaders, setNoCache } from '../headers.js'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const IdParams = Type.Object({
  id: Type.String({ pattern: UUID_V4_PATTERN }),
})
type IdParamsT = Static<typeof IdParams>

export async function registerCharityRoutes(app: FastifyInstance): Promise<void> {
  app.route<{ Querystring: ListQuery }>({
    method: 'GET',
    url: '/v1/donation/charities',
    schema: {
      querystring: ListQueryBase,
      response: { 200: CharityListResponse },
    },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const result = await listCharities({
        prisma: app.prisma,
        now: new Date(),
        locale,
        objectUrl: app.objectUrl,
        input: req.query,
      })
      setI18nHeaders(reply, locale)
      setNoCache(reply)
      return paginatedEnvelope(result)
    },
  })

  app.route<{ Params: IdParamsT }>({
    method: 'GET',
    url: '/v1/donation/charities/:id',
    schema: {
      params: IdParams,
      response: { 200: CharityDetail },
    },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const result = await getCharityById({
        prisma: app.prisma,
        now: new Date(),
        locale,
        objectUrl: app.objectUrl,
        id: req.params.id,
      })
      return sendDetail(req, reply, locale, result)
    },
  })
}
