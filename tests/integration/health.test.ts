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

  it('GET /health/live → 200 { status: "alive", build } (spec 011 §4.1 + spec 014 §4.2)', async () => {
    app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/health/live' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { status: string; build: { gitSha: string; timestamp: string; version: string } }
    expect(body.status).toBe('alive')
    expect(body.build).toEqual({
      gitSha: expect.any(String),
      timestamp: expect.any(String),
      version: expect.any(String),
    })
  })

  it('GET /health/live stays 200 even after the gate is shutDown (spec 011 §9.4)', async () => {
    app = await buildApp()
    app.readinessGate.shutDown()
    const res = await app.inject({ method: 'GET', url: '/health/live' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { status: string }).status).toBe('alive')
  })

  it('GET /health/live stays 200 even if Redis PING throws (spec 011 §4.1 / §6.1)', async () => {
    app = await buildApp()
    const originalPing = app.redis.ping.bind(app.redis)
    app.redis.ping = (() =>
      Promise.reject(new Error('simulated cache outage'))) as typeof originalPing
    const res = await app.inject({ method: 'GET', url: '/health/live' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { status: string }).status).toBe('alive')
    app.redis.ping = originalPing
  })

  it('GET /health/live build block reflects BUILD_* env when injected (spec 014 §4.2)', async () => {
    app = await buildApp({
      BUILD_GIT_SHA: 'deadbeef',
      BUILD_TIMESTAMP: '2026-06-14T00:00:00Z',
      BUILD_VERSION: '0.99.0-test',
    })
    const res = await app.inject({ method: 'GET', url: '/health/live' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { build: { gitSha: string; timestamp: string; version: string } }
    expect(body.build).toEqual({
      gitSha: 'deadbeef',
      timestamp: '2026-06-14T00:00:00Z',
      version: '0.99.0-test',
    })
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

  // ── /health (overall, spec 011 §4.4) ────────────────────────────────────

  it('GET /health → 200 { status: "ok", version, uptimeSec, components, ... } (spec 011 §4.4)', async () => {
    app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      status: string
      version: string
      uptimeSec: number
      components: { db: { status: string }; cache: { status: string } }
      startupCompleted: boolean
      shuttingDown: boolean
    }
    expect(body.status).toBe('ok')
    expect(body.version).toEqual(expect.any(String))
    expect(body.uptimeSec).toEqual(expect.any(Number))
    expect(body.components.db.status).toBe('ok')
    expect(body.components.cache.status).toBe('ok')
    expect(body.startupCompleted).toBe(true)
    expect(body.shuttingDown).toBe(false)
  })

  it('GET /health → 503 { status: "down", shuttingDown: true } once gate.shutDown() runs', async () => {
    app = await buildApp()
    app.readinessGate.shutDown()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    const body = res.json() as { status: string; shuttingDown: boolean }
    expect(body.status).toBe('down')
    expect(body.shuttingDown).toBe(true)
  })

  it('GET /health does NOT leak OS / process / env metadata (spec §14.2)', async () => {
    app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/health' })
    const text = res.payload
    // Spec §14.2 hard-no list. We only echo the short git SHA (`version`)
    // and the structured component map.
    expect(text).not.toContain(process.cwd())
    expect(text).not.toMatch(/"pid"/i)
    // Catches stray `Authorization` / token leakage just in case.
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9-_.]+/)
  })

  // ── /health/db (spec 011 §4.5) ──────────────────────────────────────────

  it('GET /health/db → 200 { status: "ok", latencyMs, details: { ping: "OK" } }', async () => {
    app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/health/db' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { status: string; latencyMs: number; details: { ping?: string } }
    expect(body.status).toBe('ok')
    expect(body.latencyMs).toEqual(expect.any(Number))
    expect(body.details.ping).toBe('OK')
  })

  // ── /health/cache (spec 011 §4.5) ───────────────────────────────────────

  it('GET /health/cache → 200 { status: "ok", latencyMs, details: { ping: "OK" } }', async () => {
    app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/health/cache' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { status: string; latencyMs: number; details: { ping?: string } }
    expect(body.status).toBe('ok')
    expect(body.details.ping).toBe('OK')
  })

  it('GET /health/cache → 503 { status: "down", details.error category } when Redis fails (spec §4.5 / §14.2)', async () => {
    app = await buildApp()
    const originalPing = app.redis.ping.bind(app.redis)
    app.redis.ping = (() =>
      Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379'))) as typeof originalPing
    try {
      const res = await app.inject({ method: 'GET', url: '/health/cache' })
      expect(res.statusCode).toBe(503)
      const body = res.json() as { status: string; details: { error?: string } }
      expect(body.status).toBe('down')
      // Spec §14.2 — error must be a category, NOT the raw connection string.
      expect(body.details.error).toBe('connection_refused')
      expect(res.payload).not.toContain('127.0.0.1')
      expect(res.payload).not.toContain('6379')
    } finally {
      app.redis.ping = originalPing
    }
  })
})
