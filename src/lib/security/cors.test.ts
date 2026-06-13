// Spec 012 §3 — CORS plugin behaviour.
//
// We construct a disposable Fastify instance, decorate `config` with a
// minimum slice (mirroring what @fastify/env would produce), register the
// cors plugin under test, then hit it with `fastify.inject()`.
//
// We do NOT exercise @fastify/env here — that is integration territory
// (spec 013). Decorating config keeps the test in the unit project per
// CLAUDE.md mocking policy ("can mock time/random/clock/id", but here we
// just supply a literal config slice — not a mock).

import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Config } from '../../config/schema.js'
import { corsPlugin } from './cors.js'

type CorsConfigSlice = Pick<Config, 'CORS_ORIGIN' | 'CORS_PREFLIGHT_MAX_AGE_SEC'>

async function buildAppWithCors(slice: CorsConfigSlice): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', slice as unknown as Config)
  await app.register(corsPlugin)
  // A target route so non-preflight requests have something to hit.
  app.get('/ping', () => ({ ok: true }))
  await app.ready()
  return app
}

describe('corsPlugin', () => {
  let app: FastifyInstance

  afterEach(async () => {
    if (app) await app.close()
  })

  describe('preflight OPTIONS — allowed origin (spec 012 §3.1)', () => {
    beforeEach(async () => {
      app = await buildAppWithCors({
        CORS_ORIGIN: 'https://app.example.com,https://staff.example.com',
        CORS_PREFLIGHT_MAX_AGE_SEC: 600,
      })
    })

    it('responds 204 with the matching Access-Control-Allow-Origin', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/ping',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization,x-request-id',
        },
      })
      expect(res.statusCode).toBe(204)
      expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com')
    })

    it('echoes Access-Control-Allow-Credentials: true (spec 012 §3.1)', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/ping',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': 'GET',
        },
      })
      expect(res.headers['access-control-allow-credentials']).toBe('true')
    })

    it('advertises the spec-mandated method set (spec 012 §3.1)', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/ping',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': 'GET',
        },
      })
      const methods = String(res.headers['access-control-allow-methods'] ?? '')
        .split(',')
        .map((m) => m.trim().toUpperCase())
      expect(methods).toEqual(
        expect.arrayContaining(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']),
      )
      expect(methods).not.toContain('TRACE')
      expect(methods).not.toContain('CONNECT')
    })

    it('advertises the spec-mandated allowed-headers (spec 012 §3.1)', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/ping',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,authorization',
        },
      })
      const allowed = String(res.headers['access-control-allow-headers'] ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
      expect(allowed).toEqual(
        expect.arrayContaining([
          'content-type',
          'authorization',
          'idempotency-key',
          'x-request-id',
        ]),
      )
    })

    it('sets Access-Control-Max-Age from config (spec 012 §3.1)', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/ping',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': 'GET',
        },
      })
      expect(res.headers['access-control-max-age']).toBe('600')
    })

    it('honours a non-default CORS_PREFLIGHT_MAX_AGE_SEC', async () => {
      await app.close()
      app = await buildAppWithCors({
        CORS_ORIGIN: 'https://app.example.com',
        CORS_PREFLIGHT_MAX_AGE_SEC: 7200,
      })
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/ping',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': 'GET',
        },
      })
      expect(res.headers['access-control-max-age']).toBe('7200')
    })
  })

  describe('preflight OPTIONS — disallowed origin (spec 012 §3.5 / §9.2)', () => {
    beforeEach(async () => {
      app = await buildAppWithCors({
        CORS_ORIGIN: 'https://app.example.com',
        CORS_PREFLIGHT_MAX_AGE_SEC: 600,
      })
    })

    it('does NOT emit Access-Control-Allow-Origin for an unknown origin', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/ping',
        headers: {
          origin: 'https://evil.example.com',
          'access-control-request-method': 'GET',
        },
      })
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })

    it('does NOT emit Access-Control-Allow-Origin for the literal "null" origin (spec 012 §3.5)', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/ping',
        headers: {
          origin: 'null',
          'access-control-request-method': 'GET',
        },
      })
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })
  })

  describe('actual (non-preflight) request', () => {
    beforeEach(async () => {
      app = await buildAppWithCors({
        CORS_ORIGIN: 'https://app.example.com',
        CORS_PREFLIGHT_MAX_AGE_SEC: 600,
      })
    })

    it('echoes Allow-Origin and exposes spec-mandated headers (spec 012 §3.1)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/ping',
        headers: { origin: 'https://app.example.com' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com')
      const exposed = String(res.headers['access-control-expose-headers'] ?? '')
        .split(',')
        .map((h) => h.trim())
      expect(exposed).toEqual(
        expect.arrayContaining([
          'X-Request-Id',
          'Location',
          'ETag',
          'Retry-After',
          'X-RateLimit-Limit',
          'X-RateLimit-Remaining',
          'X-RateLimit-Reset',
          'X-RateLimit-Layer',
        ]),
      )
    })

    it('omits Allow-Origin for an unknown origin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/ping',
        headers: { origin: 'https://evil.example.com' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })

    it('omits Allow-Origin for same-origin requests (no Origin header)', async () => {
      const res = await app.inject({ method: 'GET', url: '/ping' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })
  })
})
