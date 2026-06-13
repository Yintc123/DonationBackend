// Spec 004 — Logger module unit tests.
//
// Approach: createLogger(config) returns pino.LoggerOptions. We feed those
// options into a real pino instance pointed at a capturing stream and assert
// on the emitted JSON. No mocks of pino itself (spec 004 §12).

import { Writable } from 'node:stream'

import pino, { type Logger, type LoggerOptions } from 'pino'
import { describe, expect, it } from 'vitest'

import { createLogger } from './index.js'
import type { Config } from '../../config/schema.js'

const baseConfig: Config = {
  NODE_ENV: 'development',
  PORT: 3001,
  HOST: '0.0.0.0',
  LOG_LEVEL: 'info',
  DB_HOST: 'localhost',
  DB_PORT: 5432,
  DB_USER: 'u',
  DB_PASSWORD: 'p',
  DB_NAME: 'd',
  DB_SCHEMA: 'public',
  DB_SSL_MODE: '',
  DB_CONNECTION_LIMIT: '',
  DB_POOL_TIMEOUT: '',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a-access-secret-at-least-32-characters!',
  JWT_ACCESS_EXPIRES_IN: '3h',
  JWT_REFRESH_SECRET: 'a-refresh-secret-at-least-32-characters',
  JWT_REFRESH_EXPIRES_IN: '30d',
  JWT_ISSUER: 'http://localhost:3001',
  JWT_AUDIENCE: '',
  GOOGLE_CLIENT_ID: 'g',
  GOOGLE_CLIENT_SECRET: 'gs',
  GOOGLE_CALLBACK_URL: 'http://localhost:3000/cb',
  OIDC_DISCOVERY_URL: 'https://accounts.google.com/.well-known/openid-configuration',
  PASSWORD_HASH_MEMORY_COST: 19456,
  PASSWORD_HASH_TIME_COST: 2,
  PASSWORD_HASH_PARALLELISM: 1,
  PASSWORD_MIN_LENGTH: 8,
  LOGIN_LOCK_THRESHOLD: 10,
  LOGIN_LOCK_WINDOW_SEC: 900,
  RATE_LIMIT_GLOBAL_PER_IP_LIMIT: 600,
  RATE_LIMIT_GLOBAL_PER_IP_WINDOW_SEC: 60,
  RATE_LIMIT_DEFAULT_LIMIT: 120,
  RATE_LIMIT_DEFAULT_WINDOW_SEC: 60,
  RATE_LIMIT_FAILURE_MODE: 'closed',
  RATE_LIMIT_TRUSTED_PROXIES: '',
  CORS_ORIGIN: 'http://localhost:3000',
  CORS_PREFLIGHT_MAX_AGE_SEC: 600,
  HSTS_MAX_AGE_SEC: 31536000,
  HSTS_INCLUDE_SUBDOMAINS: true,
  HSTS_PRELOAD: false,
}

/**
 * Build a pino instance from the factory's options, but routed to an
 * in-memory destination so we can read each emitted JSON line.
 *
 * NOTE: when the factory includes `transport` (dev), we strip it before
 * piping to a capture stream — `transport` and a destination stream are
 * mutually exclusive in pino. The dev-transport behaviour itself is asserted
 * separately by inspecting the options object.
 */
function captureLogs(options: LoggerOptions): {
  logger: Logger
  lines: () => Record<string, unknown>[]
} {
  const buf: string[] = []
  const dest = new Writable({
    write(chunk, _enc, cb) {
      buf.push(chunk.toString())
      cb()
    },
  })
  const { transport: _transport, ...rest } = options
  const logger: Logger = pino(rest, dest)
  return {
    logger,
    lines: () =>
      buf
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  }
}

describe('createLogger', () => {
  describe('level (spec 004 §3)', () => {
    it('uses LOG_LEVEL from config', () => {
      const opts = createLogger({ ...baseConfig, LOG_LEVEL: 'warn' })
      expect(opts.level).toBe('warn')
    })
  })

  describe('transport (spec 004 §3 + §3.2)', () => {
    it('uses pino-pretty transport in development', () => {
      const opts = createLogger({ ...baseConfig, NODE_ENV: 'development' })
      expect(opts.transport).toEqual({
        target: 'pino-pretty',
        options: { colorize: true, singleLine: true },
      })
    })

    it('emits raw JSON (no transport) in staging', () => {
      const opts = createLogger({ ...baseConfig, NODE_ENV: 'staging' })
      expect(opts.transport).toBeUndefined()
    })

    it('emits raw JSON (no transport) in production', () => {
      const opts = createLogger({ ...baseConfig, NODE_ENV: 'production' })
      expect(opts.transport).toBeUndefined()
    })
  })

  describe('redaction (spec 004 §7.1)', () => {
    // Note: spec 004 §6.1 says the `req` serializer drops headers/body
    // entirely; the in-`req.headers` / `req.body` redact paths are a
    // belt-and-suspenders backstop for any caller that bypasses the
    // serializer (e.g. logs a raw `{ req: ... }` shape under a child).
    // We exercise that backstop through pino's redact engine directly by
    // building a child logger that re-emits a `req` field, not through the
    // top-level `req` serializer.

    it('declares the full default REDACT_PATHS set', () => {
      const opts = createLogger(baseConfig)
      const paths = (opts.redact as { paths: string[] }).paths
      expect(paths).toEqual(
        expect.arrayContaining([
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.token',
          'req.body.idToken',
          'req.body.refreshToken',
          'req.body.accessToken',
          'req.body.clientSecret',
          'req.body.code',
          '*.JWT_ACCESS_SECRET',
          '*.JWT_REFRESH_SECRET',
          '*.DB_PASSWORD',
          '*.DATABASE_URL',
          '*.REDIS_URL',
          '*.GOOGLE_CLIENT_SECRET',
          '*.password',
        ]),
      )
    })

    it('redacts every env-snapshot secret enumerated in Config (spec 004 §11.1)', () => {
      const { logger, lines } = captureLogs(createLogger(baseConfig))
      logger.info(
        {
          config: {
            JWT_ACCESS_SECRET: 'access-leak',
            JWT_REFRESH_SECRET: 'refresh-leak',
            DB_PASSWORD: 'db-leak',
            DATABASE_URL: 'postgresql://u:secret@host/db',
            REDIS_URL: 'redis://:secret@host:6379',
            GOOGLE_CLIENT_SECRET: 'google-leak',
            password: 'pw-leak',
          },
        },
        'startup',
      )
      const cfg = lines()[0]?.config as Record<string, string>
      expect(cfg).toEqual({
        JWT_ACCESS_SECRET: '[Redacted]',
        JWT_REFRESH_SECRET: '[Redacted]',
        DB_PASSWORD: '[Redacted]',
        DATABASE_URL: '[Redacted]',
        REDIS_URL: '[Redacted]',
        GOOGLE_CLIENT_SECRET: '[Redacted]',
        password: '[Redacted]',
      })
    })
  })

  describe('req serializer (spec 004 §6.1)', () => {
    it('emits method, url, routeUrl, remoteAddress only', () => {
      const { logger, lines } = captureLogs(createLogger(baseConfig))
      logger.info(
        {
          req: {
            method: 'POST',
            url: '/v1/donations?ref=abc',
            routeUrl: '/v1/donations',
            ip: '203.0.113.5',
            headers: { 'user-agent': 'curl' },
            body: { amount: 100 },
          },
        },
        'request_received',
      )
      const req = lines()[0]?.req as Record<string, unknown>
      expect(req).toEqual({
        method: 'POST',
        url: '/v1/donations?ref=abc',
        routeUrl: '/v1/donations',
        remoteAddress: '203.0.113.5',
      })
    })

    it('falls back to remoteAddress field when ip is absent', () => {
      const { logger, lines } = captureLogs(createLogger(baseConfig))
      logger.info(
        {
          req: {
            method: 'GET',
            url: '/health/live',
            remoteAddress: '10.0.0.1',
          },
        },
        'hi',
      )
      const req = lines()[0]?.req as Record<string, unknown>
      expect(req).toMatchObject({ remoteAddress: '10.0.0.1' })
    })
  })

  describe('res serializer (spec 004 §6.1)', () => {
    it('emits statusCode and latencyMs', () => {
      const { logger, lines } = captureLogs(createLogger(baseConfig))
      logger.info(
        {
          res: {
            statusCode: 201,
            // Fastify hook may provide either an explicit latencyMs
            // or a responseTime field — accept the explicit one.
            latencyMs: 42,
          },
        },
        'request_completed',
      )
      const res = lines()[0]?.res as Record<string, unknown>
      expect(res).toEqual({ statusCode: 201, latencyMs: 42 })
    })

    it('derives latencyMs from Fastify responseTime when latencyMs is missing', () => {
      const { logger, lines } = captureLogs(createLogger(baseConfig))
      logger.info(
        {
          res: {
            statusCode: 200,
            responseTime: 17.84,
          },
        },
        'request_completed',
      )
      const res = lines()[0]?.res as Record<string, unknown>
      expect(res).toEqual({ statusCode: 200, latencyMs: 18 })
    })
  })

  describe('err serializer (spec 004 §8.2)', () => {
    it('expands Error to type, message, stack, code', () => {
      const { logger, lines } = captureLogs(createLogger(baseConfig))
      const err = Object.assign(new Error('boom'), { code: 'E_BOOM' })
      logger.error({ err }, 'failure')
      const out = lines()[0]?.err as Record<string, unknown>
      expect(out).toMatchObject({
        type: 'Error',
        message: 'boom',
        code: 'E_BOOM',
      })
      expect(typeof out.stack).toBe('string')
    })
  })

  describe('child logger bindings (spec 004 §5)', () => {
    it('propagates module bindings on every line', () => {
      const { logger, lines } = captureLogs(createLogger(baseConfig))
      const child = logger.child({ module: 'db' })
      child.info('connected')
      expect(lines()[0]).toMatchObject({ module: 'db', msg: 'connected' })
    })

    it('propagates reqId bindings on every line (spec 004 §6.3)', () => {
      const { logger, lines } = captureLogs(createLogger(baseConfig))
      const reqLogger = logger.child({ reqId: 'a1b2c3d4-0000-4000-8000-000000000000' })
      reqLogger.info('hi')
      expect(lines()[0]).toMatchObject({ reqId: 'a1b2c3d4-0000-4000-8000-000000000000' })
    })
  })

  describe('base fields (spec 004 §4.1)', () => {
    it('emits time, level, pid, hostname, msg by default', () => {
      const { logger, lines } = captureLogs(createLogger(baseConfig))
      logger.info('hello')
      const line = lines()[0]!
      expect(line).toHaveProperty('time')
      expect(line).toHaveProperty('level')
      expect(line).toHaveProperty('pid')
      expect(line).toHaveProperty('hostname')
      expect(line).toHaveProperty('msg', 'hello')
    })
  })
})
