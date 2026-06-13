// Spec 012 §3 — CORS plugin.
//
// Wraps @fastify/cors with the exact options spec 012 §3.1 mandates:
//   - origin allowlist parsed from app.config.CORS_ORIGIN (no wildcards),
//   - credentials: true,
//   - methods: GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD,
//   - allowedHeaders: Content-Type, Authorization, Idempotency-Key, X-Request-Id,
//   - exposedHeaders: X-Request-Id, Location, ETag, Retry-After, X-RateLimit-*,
//   - maxAge: app.config.CORS_PREFLIGHT_MAX_AGE_SEC,
//   - optionsSuccessStatus: 204.
//
// Disallowed origins receive a response with NO Access-Control-Allow-Origin
// header — the browser then blocks the response (spec 012 §3.5 / §9.2).
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
  const allowlist = new Set(parseCorsOrigin(app.config.CORS_ORIGIN))

  await app.register(fastifyCors, {
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
    methods: [...ALLOWED_METHODS],
    allowedHeaders: [...ALLOWED_HEADERS],
    exposedHeaders: [...EXPOSED_HEADERS],
    maxAge: app.config.CORS_PREFLIGHT_MAX_AGE_SEC,
    optionsSuccessStatus: 204,
  })
}

export const corsPlugin = fp(corsPluginAsync, {
  name: 'jko-cors',
  fastify: '5.x',
  dependencies: [],
})
