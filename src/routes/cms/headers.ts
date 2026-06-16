// Spec 026 §4.3 / §8.1 — shared response-header policy for /cms read endpoints.
//
// Admin reads never go through Redis and never want a 304 round-trip
// (spec 026 §2.4). We emit `Cache-Control: no-store, private` so neither
// browsers nor intermediaries hold a copy: an admin who just PATCHed a
// row must see the new value on the next GET, with zero stale window.
//
// `Vary: Accept-Language, Origin` mirrors the public-side header policy
// (src/routes/user/headers.ts) so behaviour stays uniform across surfaces
// even though `no-store` makes Vary moot in practice.

import type { FastifyReply } from 'fastify'

import type { Locale } from '../../lib/i18n/index.js'

export function setAdminResponseHeaders(reply: FastifyReply, locale: Locale): void {
  reply.header('Content-Language', locale)
  reply.header('Vary', 'Accept-Language, Origin')
  reply.header('Cache-Control', 'no-store, private')
}
