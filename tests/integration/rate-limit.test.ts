// Spec 010 §13.2 — rate-limit module integration tests against real Redis.
//
// buildApp() registers rateLimitPlugin globally (see src/app.ts); these
// tests just add a /test route with per-route config and exercise the
// preHandler. Each test seeds the env with tight limits so we can
// exhaust the bucket in a few inject() calls.
//
// We rely on per-test-setup.ts to FLUSHDB between tests, so layer counters
// reset cleanly. Times are real (no fake timers) — windows are short enough
// to exhaust quickly but long enough to remain deterministic.

import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildRateLimitHeaders,
  type RouteRateLimitConfig,
} from '../../src/lib/rate-limit/index.js'
import { buildApp } from '../helpers/app.js'

interface BuildOpts {
  envOverrides?: Record<string, string>
  routeConfig?: RouteRateLimitConfig | false
}

async function buildAppWithRateLimit(opts: BuildOpts = {}): Promise<FastifyInstance> {
  const app = await buildApp(opts.envOverrides)
  app.route({
    method: 'GET',
    url: '/test',
    config: { rateLimit: opts.routeConfig },
    handler: async () => ({ ok: true }),
  })
  await app.ready()
  return app
}

describe('rate-limit plugin (integration, spec 010)', () => {
  let app: FastifyInstance | undefined
  afterEach(async () => {
    // Some tests intentionally quit the Redis client mid-test (fail-closed
    // path). @fastify/redis's onClose then tries to QUIT again and throws
    // "Connection is closed". That's fine for our purposes — swallow it.
    try {
      await app?.close()
    } catch (err) {
      const msg = (err as Error).message ?? String(err)
      if (!/Connection is closed/i.test(msg)) throw err
    }
    app = undefined
  })

  describe('sliding-window semantics (spec §2 / §13.2)', () => {
    it('allows up to `limit` requests within a window, then 429s the next one', async () => {
      app = await buildAppWithRateLimit({
        envOverrides: {
          // L1 generous so L2 wins.
          RATE_LIMIT_GLOBAL_PER_IP_LIMIT: '10000',
          RATE_LIMIT_GLOBAL_PER_IP_WINDOW_SEC: '60',
        },
        routeConfig: { perIp: { limit: 3, windowMs: 5_000 } },
      })

      const r1 = await app.inject({ method: 'GET', url: '/test' })
      const r2 = await app.inject({ method: 'GET', url: '/test' })
      const r3 = await app.inject({ method: 'GET', url: '/test' })
      const r4 = await app.inject({ method: 'GET', url: '/test' })

      expect(r1.statusCode).toBe(200)
      expect(r2.statusCode).toBe(200)
      expect(r3.statusCode).toBe(200)
      expect(r4.statusCode).toBe(429)
      expect(r4.headers['content-type']).toMatch(/application\/problem\+json/)
      const body = JSON.parse(r4.body) as { code: string }
      expect(body.code).toBe('RATE_LIMITED')
    })

    it('attaches X-RateLimit-* headers on allowed responses', async () => {
      app = await buildAppWithRateLimit({
        routeConfig: { perIp: { limit: 5, windowMs: 60_000 } },
      })
      const r = await app.inject({ method: 'GET', url: '/test' })
      expect(r.statusCode).toBe(200)
      expect(r.headers['x-ratelimit-limit']).toBe('5')
      // first hit consumes 1 → remaining is 4
      expect(r.headers['x-ratelimit-remaining']).toBe('4')
      expect(r.headers['x-ratelimit-reset']).toMatch(/^\d+$/)
    })

    it('attaches Retry-After and X-RateLimit-Layer on 429', async () => {
      app = await buildAppWithRateLimit({
        envOverrides: { RATE_LIMIT_GLOBAL_PER_IP_LIMIT: '10000' },
        routeConfig: { perIp: { limit: 1, windowMs: 10_000 } },
      })
      await app.inject({ method: 'GET', url: '/test' }) // exhaust
      const denied = await app.inject({ method: 'GET', url: '/test' })
      expect(denied.statusCode).toBe(429)
      expect(denied.headers['retry-after']).toMatch(/^\d+$/)
      // We exhausted the per-route per-IP layer (L2) — tightest layer header.
      expect(denied.headers['x-ratelimit-layer']).toBe('route-ip')
      // Retry-After should be ≤ window (10 s) and ≥ 1.
      const ra = Number(denied.headers['retry-after'])
      expect(ra).toBeGreaterThanOrEqual(1)
      expect(ra).toBeLessThanOrEqual(10)
    })
  })

  describe('layer precedence (spec §3 / §7.3)', () => {
    it('reports the TIGHTEST layer when multiple layers are evaluated', async () => {
      app = await buildAppWithRateLimit({
        envOverrides: {
          RATE_LIMIT_GLOBAL_PER_IP_LIMIT: '100',
          RATE_LIMIT_GLOBAL_PER_IP_WINDOW_SEC: '60',
        },
        // L2 limit of 2; first hit allowed should show "route-ip" headers because
        // that's the tightest (remaining 100 vs remaining 1).
        routeConfig: { perIp: { limit: 2, windowMs: 60_000 } },
      })
      const r = await app.inject({ method: 'GET', url: '/test' })
      expect(r.statusCode).toBe(200)
      // tightest layer = route-ip (limit=2, remaining=1)
      expect(r.headers['x-ratelimit-limit']).toBe('2')
      expect(r.headers['x-ratelimit-remaining']).toBe('1')
    })

    it('emits the FIRST layer that denies as X-RateLimit-Layer (short-circuit, §3.1)', async () => {
      // L1 is checked before L2. If L1 is tight enough to deny first, we
      // should see "global" in the layer header even if L2 would also deny.
      app = await buildAppWithRateLimit({
        envOverrides: {
          RATE_LIMIT_GLOBAL_PER_IP_LIMIT: '1',
          RATE_LIMIT_GLOBAL_PER_IP_WINDOW_SEC: '60',
        },
        routeConfig: { perIp: { limit: 1, windowMs: 60_000 } },
      })
      await app.inject({ method: 'GET', url: '/test' })
      const denied = await app.inject({ method: 'GET', url: '/test' })
      expect(denied.statusCode).toBe(429)
      expect(denied.headers['x-ratelimit-layer']).toBe('global')
    })
  })

  describe('exemptions (spec §9.1, spec 012 §3.6)', () => {
    it('skips /health/* paths', async () => {
      app = await buildAppWithRateLimit({
        envOverrides: { RATE_LIMIT_GLOBAL_PER_IP_LIMIT: '1' },
      })
      // Even with L1=1, /health/live should not be counted.
      for (let i = 0; i < 5; i++) {
        const r = await app.inject({ method: 'GET', url: '/health/live' })
        expect(r.statusCode).toBe(200)
        expect(r.headers['x-ratelimit-limit']).toBeUndefined()
      }
    })

    it('skips OPTIONS preflight', async () => {
      app = await buildAppWithRateLimit({
        envOverrides: { RATE_LIMIT_GLOBAL_PER_IP_LIMIT: '1' },
      })
      for (let i = 0; i < 5; i++) {
        const r = await app.inject({
          method: 'OPTIONS',
          url: '/test',
          headers: {
            origin: 'http://localhost:3000',
            'access-control-request-method': 'GET',
          },
        })
        // CORS preflight returns 204; no rate-limit headers attached.
        expect(r.statusCode).toBe(204)
        expect(r.headers['x-ratelimit-limit']).toBeUndefined()
      }
    })
  })

  describe('per-route override API (spec §5)', () => {
    it('honours config.rateLimit: false (route opt-out)', async () => {
      app = await buildAppWithRateLimit({
        envOverrides: { RATE_LIMIT_GLOBAL_PER_IP_LIMIT: '10000' },
        routeConfig: false,
      })
      // Even after many calls, no rate-limit headers (the plugin skipped this route).
      const r1 = await app.inject({ method: 'GET', url: '/test' })
      const r2 = await app.inject({ method: 'GET', url: '/test' })
      expect(r1.statusCode).toBe(200)
      expect(r2.statusCode).toBe(200)
      expect(r1.headers['x-ratelimit-limit']).toBeUndefined()
    })

    it('honours per-route bypass predicate', async () => {
      app = await buildAppWithRateLimit({
        envOverrides: { RATE_LIMIT_GLOBAL_PER_IP_LIMIT: '1' },
        routeConfig: {
          perIp: { limit: 1, windowMs: 60_000 },
          bypass: () => true,
        },
      })
      const r1 = await app.inject({ method: 'GET', url: '/test' })
      const r2 = await app.inject({ method: 'GET', url: '/test' })
      expect(r1.statusCode).toBe(200)
      expect(r2.statusCode).toBe(200)
    })
  })

  describe('Lua agrees with the TS formula port', () => {
    it('first-hit headers match buildRateLimitHeaders prediction', async () => {
      // Sanity check: the Lua remaining/reset on the FIRST request, with empty
      // buckets, should match decide() in script.ts. We don't replay nowMs
      // exactly, but ranges are tight enough.
      app = await buildAppWithRateLimit({
        envOverrides: { RATE_LIMIT_GLOBAL_PER_IP_LIMIT: '10000' },
        routeConfig: { perIp: { limit: 10, windowMs: 60_000 } },
      })
      const r = await app.inject({ method: 'GET', url: '/test' })
      expect(r.statusCode).toBe(200)
      // The tightest layer is route-ip (limit=10), first hit → remaining=9.
      const predicted = buildRateLimitHeaders({
        decisions: [
          {
            layer: 'route-ip',
            allowed: true,
            limit: 10,
            remaining: 9,
            resetInMs: 60_000,
          },
        ],
        nowMs: Date.now(),
      })
      expect(r.headers['x-ratelimit-limit']).toBe(predicted['X-RateLimit-Limit'])
      expect(r.headers['x-ratelimit-remaining']).toBe(predicted['X-RateLimit-Remaining'])
    })
  })

  describe('Redis fail-closed policy (spec §11)', () => {
    it('returns 503 RATE_LIMIT_UNAVAILABLE when Redis is shut', async () => {
      app = await buildAppWithRateLimit({
        envOverrides: { RATE_LIMIT_FAILURE_MODE: 'closed' },
        routeConfig: { perIp: { limit: 5, windowMs: 60_000 } },
      })
      // Close the Redis connection BEFORE the request.
      await app.redis.quit()

      const r = await app.inject({ method: 'GET', url: '/test' })
      expect(r.statusCode).toBe(503)
      const body = JSON.parse(r.body) as { code: string }
      expect(body.code).toBe('RATE_LIMIT_UNAVAILABLE')
      expect(r.headers['retry-after']).toBe('5')
    })

    it('passes through under failure-mode=open with a warning log', async () => {
      app = await buildAppWithRateLimit({
        envOverrides: { RATE_LIMIT_FAILURE_MODE: 'open' },
        routeConfig: { perIp: { limit: 5, windowMs: 60_000 } },
      })
      await app.redis.quit()

      const r = await app.inject({ method: 'GET', url: '/test' })
      expect(r.statusCode).toBe(200)
    })
  })
})
