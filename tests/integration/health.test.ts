// Spec 011 §13.2 — integration tests against a real Fastify stack.
// Uses the shared tests/helpers/app.ts buildApp() which registers the
// full plugin chain (errorHandler → security → http → prisma → redis →
// rate-limit → health) against the live testcontainers.

import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../helpers/app.js'

describe('healthPlugin (integration, spec 011 §13.2)', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // ── /health/live ────────────────────────────────────────────────────────

  it('GET /health/live → 200 { status: "alive" } (spec 011 §4.1)', async () => {
    app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/health/live' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'alive' })
  })

  it('GET /health/live stays 200 even after the gate is shutDown (spec 011 §9.4)', async () => {
    app = await buildApp()
    app.readinessGate.shutDown()
    const res = await app.inject({ method: 'GET', url: '/health/live' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'alive' })
  })

  it('GET /health/live stays 200 even if Redis PING throws (spec 011 §4.1 / §6.1)', async () => {
    app = await buildApp()
    const originalPing = app.redis.ping.bind(app.redis)
    app.redis.ping = (() =>
      Promise.reject(new Error('simulated cache outage'))) as typeof originalPing
    const res = await app.inject({ method: 'GET', url: '/health/live' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'alive' })
    app.redis.ping = originalPing
  })

  // ── /health/ready ───────────────────────────────────────────────────────

  it('GET /health/ready → 200 { status: "ready", components: { db, cache: "ok" } } (spec 011 §4.2)', async () => {
    app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body.status).toBe('ready')
    expect(body.components).toEqual({ db: 'ok', cache: 'ok' })
  })

  it('GET /health/ready → 503 { status: "draining" } once gate.shutDown() is called (spec 011 §9.3)', async () => {
    app = await buildApp()
    app.readinessGate.shutDown()
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(503)
    const body = res.json() as Record<string, unknown>
    expect(body.status).toBe('draining')
    expect(body).not.toHaveProperty('components')
    expect(body).toHaveProperty('uptimeSec')
  })

  it('GET /health/ready → 503 { components.cache: "fail" } when Redis PING fails (spec 011 §4.2)', async () => {
    app = await buildApp()
    const originalPing = app.redis.ping.bind(app.redis)
    app.redis.ping = (() =>
      Promise.reject(new Error('simulated cache outage'))) as typeof originalPing
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(503)
    const body = res.json() as { status: string; components: Record<string, string> }
    expect(body.status).toBe('not_ready')
    expect(body.components.cache).toBe('fail')
    app.redis.ping = originalPing
  })

  // Regression — memoizeProbe MUST NOT cache fail results (spec 011 §7.2).
  // Before the consolidation, a 1ms failure pinned readiness to 503 for the
  // full 1s TTL window. Now the second consecutive request must reflect the
  // recovered state.
  it('GET /health/ready recovers immediately after a transient cache failure (fail not cached)', async () => {
    app = await buildApp()
    const originalPing = app.redis.ping.bind(app.redis)
    let calls = 0
    app.redis.ping = (() => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('simulated transient blip'))
      return originalPing()
    }) as typeof originalPing

    const failed = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(failed.statusCode).toBe(503)

    const recovered = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(recovered.statusCode).toBe(200)
    expect(calls).toBeGreaterThanOrEqual(2)

    app.redis.ping = originalPing
  })

  // The "JWT secrets identical" startup-fail check still belongs here —
  // it exercises the config loader, not the plugin chain.
  it('startup fails when JWT secrets are identical', async () => {
    const dup = 'duplicated-secret-at-least-32-characters!'
    await expect(
      buildApp({ JWT_ACCESS_SECRET: dup, JWT_REFRESH_SECRET: dup }),
    ).rejects.toThrow(/must differ/)
  })

  // ── /health/startup ─────────────────────────────────────────────────────

  it('GET /health/startup → 200 { status: "started" } once the app is ready (spec 011 §4.3)', async () => {
    app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/health/startup' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'started' })
  })
})
