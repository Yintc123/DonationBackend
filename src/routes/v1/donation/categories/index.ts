// Spec 016 §6 — categories dictionary.
//
// Conditional GET: the service precomputes a strong ETag over locale + the
// (id, updatedAt) tuple of each row. `sendCategories` wires that ETag onto
// the response and short-circuits to 304 when `If-None-Match` matches.
//
// Spec 019 §6.2 — handler delegates to the cached-category adapter; the
// adapter wraps listCategories with Redis cache-aside. The route layer keeps
// ownership of locale parsing + ETag/Cache-Control header policy.

import type { FastifyInstance } from 'fastify'

import { parseAcceptLanguage } from '../../../../lib/i18n/index.js'
import { CategoryListResponse } from '../../../../schemas/category/list.js'
import { listCachedCategories } from '../../../../services/cached-category.js'

import { sendCategories } from '../headers.js'

export async function registerCategoryRoutes(app: FastifyInstance): Promise<void> {
  app.route({
    method: 'GET',
    url: '/donation/categories',
    schema: {
      response: { 200: CategoryListResponse },
    },
    handler: async (req, reply) => {
      const locale = parseAcceptLanguage(req.headers['accept-language'])
      const { items, etag } = await listCachedCategories({
        prisma: app.prisma,
        redis: app.redis,
        logger: req.log,
        locale,
      })
      return sendCategories(req, reply, locale, { body: { items }, etag })
    },
  })
}
