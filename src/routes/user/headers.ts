// Spec 016 §8 / spec 017 §2 — shared response-header policy for the
// donation public endpoints.

import type { FastifyReply, FastifyRequest } from 'fastify'

import { ifNoneMatch } from '../../lib/http/index.js'
import type { Locale } from '../../lib/i18n/index.js'

/**
 * Apply Content-Language + Vary headers per spec 016 §8 / spec 017 §2.
 * Cache-Control is owned per-endpoint (list / detail vs. categories).
 *
 * `Vary` lists both `Accept-Language` AND `Origin`:
 *   - Accept-Language so CDNs / proxies cache zh-TW vs en separately
 *     (spec 016 §8 + spec 017 §2 contract requirement)
 *   - Origin so credentialed cross-origin caches stay per-origin
 *     (@fastify/cors only emits `Vary: Origin` on preflight, not on
 *     simple GET — we set it here uniformly so the rule holds even when
 *     someone caches a credentialed response)
 *
 * Fastify's `reply.header()` overwrites, so we emit the full combined
 * value rather than appending. RFC 7231 §7.1.4 allows the comma form.
 */
export function setI18nHeaders(reply: FastifyReply, locale: Locale): void {
  reply.header('Content-Language', locale)
  reply.header('Vary', 'Accept-Language, Origin')
}

/** Spec 016 §11.1 — list / detail are time-sensitive (lifecycle filter). */
export function setNoCache(reply: FastifyReply): void {
  reply.header('Cache-Control', 'private, max-age=0, must-revalidate')
}

/**
 * Spec 016 §6.4 v0.13 — categories dictionary cache policy.
 *
 * `public, max-age=300` — CDN / browser can serve fresh for 5 min.
 * `stale-while-revalidate=86400` — for 24h after expiry, return stale and
 * revalidate in background (dictionary is near-immutable; admin edits
 * tolerate eventual freshness).
 * `must-revalidate` retained so a stale response can never be served past
 * the SWR window without a successful revalidation.
 */
export function setCategoriesCache(reply: FastifyReply): void {
  reply.header(
    'Cache-Control',
    'public, max-age=300, must-revalidate, stale-while-revalidate=86400',
  )
}

/**
 * Spec 016 §6 / spec 017 §2 — wire ETag + If-None-Match → 304 for the
 * categories dictionary. Same conditional-GET shape as `sendDetail`.
 */
export function sendCategories<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  locale: Locale,
  result: { body: T; etag: string },
): T | FastifyReply {
  setI18nHeaders(reply, locale)
  setCategoriesCache(reply)
  reply.header('ETag', result.etag)
  if (ifNoneMatch(req, result.etag)) {
    return reply.code(304).send()
  }
  return result.body
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
