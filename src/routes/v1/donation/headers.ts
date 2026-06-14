// Spec 016 §8 / spec 017 §2 — shared response-header policy for the
// donation public endpoints.

import type { FastifyReply, FastifyRequest } from 'fastify'

import { ifNoneMatch } from '../../../lib/http/index.js'
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

/**
 * Spec 017 §2 — send a detail response with ETag + conditional GET.
 *
 * RFC 7232 §4.1: a 304 response MUST include ETag, Vary, and Cache-Control
 * if they would have been sent in the 200. We set those before the 304
 * short-circuit so both paths emit a consistent header set.
 */
export function sendDetail<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  locale: Locale,
  result: { body: T; etag: string },
): T | FastifyReply {
  setI18nHeaders(reply, locale)
  setNoCache(reply)
  reply.header('ETag', result.etag)
  if (ifNoneMatch(req, result.etag)) {
    return reply.code(304).send()
  }
  return result.body
}
