// Spec 016 §6 — categories dictionary.

import type { FastifyInstance } from 'fastify'

import { listCategories } from '../../../../domain/category/list.js'
import { parseAcceptLanguage } from '../../../../lib/i18n/index.js'
import { CategoryListResponse } from '../../../../schemas/category/list.js'

import { setCategoriesCache, setI18nHeaders } from '../headers.js'

export async function registerCategoryRoutes(app: FastifyInstance): Promise<void> {
  app.route({
    method: 'GET',
    url: '/v1/donation/categories',
    schema: {
      response: { 200: CategoryListResponse },
    },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const items = await listCategories({ prisma: app.prisma, locale })
      setI18nHeaders(reply, locale)
      setCategoriesCache(reply)
      return { items }
    },
  })
}
