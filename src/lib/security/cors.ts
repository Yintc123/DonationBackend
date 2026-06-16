// Spec 012 §3 — CORS plugin.
//
// Two operating modes selected from app.config.CORS_ORIGIN (spec 012 §3.1
// v0.2):
//
//   1. allowlist (production-typical) — `credentials: true`, exact-match
//      against the parsed list. Unknown origins receive no
//      Access-Control-Allow-Origin header → the browser blocks the reply
//      (spec §3.5 / §9.2).
//
//   2. wildcard  (`CORS_ORIGIN=*`) — `origin: '*'`, `credentials: false`.
//      W3C forbids `*` + credentials, so we force credentials off in this
//      mode. Auth in this backend is Bearer-token only (no cookies; the
//      Authorization header is set manually by JS), so the credentials
//      downgrade does NOT break authenticated calls.
//
// Other options are identical in both modes:
//   - methods: GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD,
//   - allowedHeaders: Content-Type, Authorization, Idempotency-Key, X-Request-Id,
//   - exposedHeaders: X-Request-Id, Location, ETag, Retry-After, X-RateLimit-*,
//   - maxAge: app.config.CORS_PREFLIGHT_MAX_AGE_SEC,
//   - optionsSuccessStatus: 204.
//
// Registered AFTER helmet (spec 012 §4 — helmet runs first so its security
// headers also appear on CORS preflight responses).

import fastifyCors from '@fastify/cors'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { parseCorsOrigin } from './parse-origin.js'

/** Spec 012 §3.1 — methods allowlist. */
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const

/** Spec 012 §3.1 — request headers a BFF may send. */
const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'Idempotency-Key',
  'X-Request-Id',
] as const

/**
 * Spec 012 §3.1 — response headers the BFF must be able to read.
 * Keep in sync with spec 009 §6 + spec 010 (rate-limit) — see spec 012 §9.5.
 */
const EXPOSED_HEADERS = [
  'X-Request-Id',
  'Location',
  'ETag',
  'Retry-After',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  'X-RateLimit-Layer',
] as const

const corsPluginAsync: FastifyPluginAsync = async (app: FastifyInstance) => {
  const config = parseCorsOrigin(app.config.CORS_ORIGIN)

  // Shared response-side options. Only `origin` and `credentials` differ
  // between modes (see header comment).
  const baseOptions = {
    methods: [...ALLOWED_METHODS],
    allowedHeaders: [...ALLOWED_HEADERS],
    exposedHeaders: [...EXPOSED_HEADERS],
    maxAge: app.config.CORS_PREFLIGHT_MAX_AGE_SEC,
    optionsSuccessStatus: 204 as const,
  }

  if (config.mode === 'wildcard') {
    app.log.warn(
      { event: 'cors_wildcard_mode' },
      'CORS_ORIGIN=* — wildcard mode: credentials disabled per W3C',
    )
    await app.register(fastifyCors, {
      ...baseOptions,
      origin: '*',
      // Forced false: W3C does not allow `*` + credentials. Safe here
      // because all auth is Bearer-token via the Authorization header,
      // which JS sets manually and does NOT require credentials mode.
      credentials: false,
    })
    return
  }

  const allowlist = new Set(config.origins)

  await app.register(fastifyCors, {
    ...baseOptions,
    // Spec 012 §3.3 — exact-match allowlist; unknown origins receive a
    // response with no Access-Control-Allow-Origin header (origin: false).
    // Same-origin requests (no Origin header) → origin: false as well
    // (no CORS headers emitted, which is correct behaviour).
    origin: (origin, cb) => {
      if (origin === undefined) {
        cb(null, false)
        return
      }
      // Spec 012 §3.5 — never allow the literal "null" origin.
      if (origin === 'null') {
        cb(null, false)
        return
      }
      cb(null, allowlist.has(origin))
    },
    credentials: true,
  })
}

export const corsPlugin = fp(corsPluginAsync, {
  name: 'jko-cors',
  fastify: '5.x',
  dependencies: [],
})
