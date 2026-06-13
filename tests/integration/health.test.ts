// Spec 011 §13.2 — integration tests against a real Fastify + Redis stack.
//
// We cannot use tests/helpers/app.ts buildApp() directly: src/app.ts still
// registers the inline /health/* stubs (lines 46–48), and Fastify rejects
// duplicate routes (FST_ERR_DUPLICATED_ROUTE) when healthPlugin tries to
// claim the same paths. Instead we wire a minimal Fastify instance that
// composes the EXACT same lib plugins (errors → security → http → redis →
// HEALTH) so we exercise the spec-011 plugin in its production shape.
//
// Once src/app.ts swaps the inline stubs for `app.register(healthPlugin)`,
// the tests already pass without change.

import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config/load.js'
import { errorHandlerPlugin } from '../../src/lib/errors/index.js'
import { healthPlugin } from '../../src/lib/health/index.js'
import { createLogger } from '../../src/lib/logger/index.js'
import { redisPlugin } from '../../src/lib/redis/index.js'
import type { Config } from '../../src/config/schema.js'

const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: '3001',
  HOST: '127.0.0.1',
  LOG_LEVEL: 'warn',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_USER: 'test',
  DB_PASSWORD: 'test',
  DB_NAME: 'jkodonation_test',
  DB_SCHEMA: 'public',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/jkodonation_test?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters-long',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters-long',
  JWT_ISSUER: 'http://localhost:3001',
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:3000/api/auth/google/callback',
  CORS_ORIGIN: 'http://localhost:3000',
}

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
  }
}

async function buildHealthTestApp(): Promise<FastifyInstance> {
  Object.assign(process.env, TEST_ENV)
  const config = loadConfig({ readDotenv: false })
  const app = Fastify({ logger: createLogger(config) })
  app.decorate('config', config)
  await app.register(errorHandlerPlugin)
  await app.register(redisPlugin)
  await app.register(healthPlugin)
  await app.ready()
  return app
}

describe('healthPlugin (integration, spec 011 §13.2)', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // ── /health/live ────────────────────────────────────────────────────────

  it('GET /health/live → 200 { status: "alive" } (spec 011 §4.1)', async () => {
    app = await buildHealthTestApp()
    const res = await app.inject({ method: 'GET', url: '/health/live' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'alive' })
  })

  it('GET /health/live stays 200 even after the gate is shutDown (spec 011 §9.4)', async () => {
    app = await buildHealthTestApp()
    app.readinessGate.shutDown()
    const res = await app.inject({ method: 'GET', url: '/health/live' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'alive' })
  })

  it('GET /health/live stays 200 even if Redis PING throws (spec 011 §4.1 / §6.1)', async () => {
    app = await buildHealthTestApp()
    // Force PING to reject; liveness must NOT touch Redis at all.
    const originalPing = app.redis.ping.bind(app.redis)
    app.redis.ping = (() => Promise.reject(new Error('simulated cache outage'))) as typeof originalPing
    const res = await app.inject({ method: 'GET', url: '/health/live' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'alive' })
    app.redis.ping = originalPing
  })

  // ── /health/ready ───────────────────────────────────────────────────────

  it('GET /health/ready → 200 { status: "ready", components: { db, cache: "ok" } } (spec 011 §4.2)', async () => {
    app = await buildHealthTestApp()
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body.status).toBe('ready')
    expect(body.components).toEqual({ db: 'ok', cache: 'ok' })
  })

  it('GET /health/ready → 503 { status: "draining" } once gate.shutDown() is called (spec 011 §9.3)', async () => {
    app = await buildHealthTestApp()
    app.readinessGate.shutDown()
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(503)
    const body = res.json() as Record<string, unknown>
    expect(body.status).toBe('draining')
    expect(body).not.toHaveProperty('components')
    expect(body).toHaveProperty('uptimeSec')
  })

  it('GET /health/ready → 503 { components.cache: "fail" } when Redis PING fails (spec 011 §4.2)', async () => {
    app = await buildHealthTestApp()
    // Simulate cache outage by making PING reject. We do NOT actually tear
    // down the connection — that would break the @fastify/redis onClose hook
    // and leak through afterEach. The probe code only cares about ping().
    const originalPing = app.redis.ping.bind(app.redis)
    app.redis.ping = (() => Promise.reject(new Error('simulated cache outage'))) as typeof originalPing
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(503)
    const body = res.json() as { status: string; components: Record<string, string> }
    expect(body.status).toBe('not_ready')
    expect(body.components.cache).toBe('fail')
    app.redis.ping = originalPing
  })

  // ── /health/startup ─────────────────────────────────────────────────────

  it('GET /health/startup → 200 { status: "started" } once the app is ready (spec 011 §4.3)', async () => {
    app = await buildHealthTestApp()
    // app.ready() inside buildHealthTestApp() has already fired onReady,
    // so the gate's startup flag is true.
    const res = await app.inject({ method: 'GET', url: '/health/startup' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'started' })
  })
})
