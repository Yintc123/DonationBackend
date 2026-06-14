// Spec 016 §8 / spec 017 §2 — shared response-header policy for the
// donation public endpoints.

import type { FastifyReply } from 'fastify'

import type { Locale } from '../../../lib/i18n/index.js'

/**
 * Apply Content-Language + Vary headers per spec 016 §8 / spec 017 §2.
 * Cache-Control is owned per-endpoint (list / detail vs. categories).
 */
export function setI18nHeaders(reply: FastifyReply, locale: Locale): void {
  reply.header('Content-Language', locale)
  reply.header('Vary', 'Accept-Language')
}

/** Spec 016 §11.1 — list / detail are time-sensitive (lifecycle filter). */
export function setNoCache(reply: FastifyReply): void {
  reply.header('Cache-Control', 'private, max-age=0, must-revalidate')
}

/** Spec 016 §6.4 — categories dictionary is cacheable for 5 min. */
export function setCategoriesCache(reply: FastifyReply): void {
  reply.header('Cache-Control', 'public, max-age=300, must-revalidate')
}
