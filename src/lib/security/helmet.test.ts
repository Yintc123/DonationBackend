// Spec 012 §4 / §5 — helmet plugin behaviour.

import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Config } from '../../config/schema.js'
import { helmetPlugin } from './helmet.js'

type HelmetConfigSlice = Pick<
  Config,
  'HSTS_MAX_AGE_SEC' | 'HSTS_INCLUDE_SUBDOMAINS' | 'HSTS_PRELOAD'
>

async function buildAppWithHelmet(slice: HelmetConfigSlice): Promise<FastifyInstance> {
  const app = Fastify()
  app.decorate('config', slice as unknown as Config)
  await app.register(helmetPlugin)
  app.get('/ping', () => ({ ok: true }))
  await app.ready()
  return app
}

describe('helmetPlugin', () => {
  let app: FastifyInstance

  afterEach(async () => {
    if (app) await app.close()
  })

  describe('default config (spec 012 §4.1)', () => {
    beforeEach(async () => {
      app = await buildAppWithHelmet({
        HSTS_MAX_AGE_SEC: 31536000,
        HSTS_INCLUDE_SUBDOMAINS: true,
        HSTS_PRELOAD: false,
      })
    })

    it('sets Strict-Transport-Security with max-age=31536000; includeSubDomains (spec 012 §4.1)', async () => {
      const res = await app.inject({ method: 'GET', url: '/ping' })
      expect(res.headers['strict-transport-security']).toBe(
        'max-age=31536000; includeSubDomains',
      )
    })

    it('sets X-Content-Type-Options: nosniff', async () => {
      const res = await app.inject({ method: 'GET', url: '/ping' })
      expect(res.headers['x-content-type-options']).toBe('nosniff')
    })

    it('sets X-Frame-Options: DENY (spec 012 §4.1 upgrade from helmet default)', async () => {
      const res = await app.inject({ method: 'GET', url: '/ping' })
      expect(res.headers['x-frame-options']).toBe('DENY')
    })

    it('sets Referrer-Policy: no-referrer', async () => {
      const res = await app.inject({ method: 'GET', url: '/ping' })
      expect(res.headers['referrer-policy']).toBe('no-referrer')
    })

    it('sets Cross-Origin-Opener-Policy: same-origin', async () => {
      const res = await app.inject({ method: 'GET', url: '/ping' })
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin')
    })

    it('sets Cross-Origin-Embedder-Policy: require-corp', async () => {
      const res = await app.inject({ method: 'GET', url: '/ping' })
      expect(res.headers['cross-origin-embedder-policy']).toBe('require-corp')
    })

    it('sets Cross-Origin-Resource-Policy: same-site (spec 012 §4.1 override)', async () => {
      const res = await app.inject({ method: 'GET', url: '/ping' })
      expect(res.headers['cross-origin-resource-policy']).toBe('same-site')
    })

    it('sets X-DNS-Prefetch-Control: off', async () => {
      const res = await app.inject({ method: 'GET', url: '/ping' })
      expect(res.headers['x-dns-prefetch-control']).toBe('off')
    })

    it('sets X-Download-Options: noopen', async () => {
      const res = await app.inject({ method: 'GET', url: '/ping' })
      expect(res.headers['x-download-options']).toBe('noopen')
    })

    it('sets X-Permitted-Cross-Domain-Policies: none', async () => {
      const res = await app.inject({ method: 'GET', url: '/ping' })
      expect(res.headers['x-permitted-cross-domain-policies']).toBe('none')
    })

    it('sets Content-Security-Policy with the exact spec 012 §5.1 directives', async () => {
      const res = await app.inject({ method: 'GET', url: '/ping' })
      const csp = String(res.headers['content-security-policy'] ?? '')
      const directives = csp
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .sort()
      expect(directives).toEqual(
        [
          "default-src 'none'",
          "frame-ancestors 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].sort(),
      )
    })

    it('sets Permissions-Policy with all spec-listed features disabled (spec 012 §4.1)', async () => {
      const res = await app.inject({ method: 'GET', url: '/ping' })
      const pp = String(res.headers['permissions-policy'] ?? '')
      const features = pp
        .split(',')
        .map((f) => f.trim())
        .sort()
      expect(features).toEqual(
        [
          'accelerometer=()',
          'camera=()',
          'geolocation=()',
          'microphone=()',
          'payment=()',
          'usb=()',
        ].sort(),
      )
    })

    it('does NOT leak X-Powered-By (spec 012 §4.2)', async () => {
      const res = await app.inject({ method: 'GET', url: '/ping' })
      expect(res.headers['x-powered-by']).toBeUndefined()
    })

    it('applies all mandatory headers to every route, including health (spec 012 §9.4)', async () => {
      await app.close()
      app = Fastify()
      app.decorate('config', {
        HSTS_MAX_AGE_SEC: 31536000,
        HSTS_INCLUDE_SUBDOMAINS: true,
        HSTS_PRELOAD: false,
      } as unknown as Config)
      await app.register(helmetPlugin)
      app.get('/health/live', () => ({ status: 'ok' }))
      await app.ready()
      const res = await app.inject({ method: 'GET', url: '/health/live' })
      expect(res.headers['strict-transport-security']).toBeDefined()
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['x-frame-options']).toBe('DENY')
      expect(res.headers['content-security-policy']).toBeDefined()
      expect(res.headers['permissions-policy']).toBeDefined()
    })
  })

  describe('HSTS variations', () => {
    afterEach(async () => {
      if (app) await app.close()
    })

    it('omits includeSubDomains when HSTS_INCLUDE_SUBDOMAINS is false', async () => {
      app = await buildAppWithHelmet({
        HSTS_MAX_AGE_SEC: 31536000,
        HSTS_INCLUDE_SUBDOMAINS: false,
        HSTS_PRELOAD: false,
      })
      const res = await app.inject({ method: 'GET', url: '/ping' })
      const hsts = String(res.headers['strict-transport-security'] ?? '')
      expect(hsts).toBe('max-age=31536000')
    })

    it('adds preload when HSTS_PRELOAD is true', async () => {
      app = await buildAppWithHelmet({
        HSTS_MAX_AGE_SEC: 63072000,
        HSTS_INCLUDE_SUBDOMAINS: true,
        HSTS_PRELOAD: true,
      })
      const res = await app.inject({ method: 'GET', url: '/ping' })
      expect(res.headers['strict-transport-security']).toBe(
        'max-age=63072000; includeSubDomains; preload',
      )
    })

    it('honours a custom HSTS max-age', async () => {
      app = await buildAppWithHelmet({
        HSTS_MAX_AGE_SEC: 60,
        HSTS_INCLUDE_SUBDOMAINS: true,
        HSTS_PRELOAD: false,
      })
      const res = await app.inject({ method: 'GET', url: '/ping' })
      expect(res.headers['strict-transport-security']).toBe(
        'max-age=60; includeSubDomains',
      )
    })
  })
})
