// Spec 016 §3 / spec 017 §5 — SaleItem list + detail.

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

import { paginatedEnvelope } from '../../../../lib/http/index.js'
import { parseAcceptLanguage } from '../../../../lib/i18n/index.js'
import {
  getSaleItemById,
  listSaleItems,
} from '../../../../domain/donation-item/index.js'
import { SaleItemDetail } from '../../../../schemas/donation-item/detail.js'
import { SaleItemListResponse } from '../../../../schemas/donation-item/list-item.js'
import {
  ListQueryWithCharityId,
  type ListQueryWithCharity,
} from '../../../../schemas/donation-item/shared.js'

import { setI18nHeaders, setNoCache } from '../headers.js'

const UUID_V4_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

const IdParams = Type.Object({
  id: Type.String({ pattern: UUID_V4_PATTERN }),
})
type IdParamsT = Static<typeof IdParams>

export async function registerSaleItemRoutes(app: FastifyInstance): Promise<void> {
  app.route<{ Querystring: ListQueryWithCharity }>({
    method: 'GET',
    url: '/v1/donation/sale-items',
    schema: {
      querystring: ListQueryWithCharityId,
      response: { 200: SaleItemListResponse },
    },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const result = await listSaleItems({
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
    url: '/v1/donation/sale-items/:id',
    schema: {
      params: IdParams,
      response: { 200: SaleItemDetail },
    },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const body = await getSaleItemById({
        prisma: app.prisma,
        now: new Date(),
        locale,
        objectUrl: app.objectUrl,
        id: req.params.id,
      })
      setI18nHeaders(reply, locale)
      setNoCache(reply)
      return body
    },
  })
}
