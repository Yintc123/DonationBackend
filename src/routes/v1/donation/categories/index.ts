// Spec 016 §6 — categories dictionary.
//
// Conditional GET: the service precomputes a strong ETag over locale + the
// (id, updatedAt) tuple of each row. `sendCategories` wires that ETag onto
// the response and short-circuits to 304 when `If-None-Match` matches.

import type { FastifyInstance } from 'fastify'

import { listCategories } from '../../../../domain/category/list.js'
import { parseAcceptLanguage } from '../../../../lib/i18n/index.js'
import { CategoryListResponse } from '../../../../schemas/category/list.js'

import { sendCategories } from '../headers.js'

export async function registerCategoryRoutes(app: FastifyInstance): Promise<void> {
  app.route({
    method: 'GET',
    url: '/v1/donation/categories',
    schema: {
      response: { 200: CategoryListResponse },
    },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const { items, etag } = await listCategories({ prisma: app.prisma, locale })
      return sendCategories(req, reply, locale, { body: { items }, etag })
    },
  })
}
