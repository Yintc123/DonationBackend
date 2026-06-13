// Spec 013 §8.2 — test harness around src/app.ts buildApp().
// Injects spec 001 §4.3 required env vars (overridable per call) so the real
// config loader runs in tests (per spec 013 §8.2 — do NOT mock loaders).
//
// Source of truth for each env var:
//   - infrastructure (DB_*, REDIS_URL, DATABASE_URL)
//       → vitest inject() values supplied by tests/setup/global-setup.ts
//         from the live testcontainers
//   - app-level config (JWT_*, GOOGLE_*, CORS_ORIGIN, etc.)
//       → APP_TEST_DEFAULTS below
//   - per-test overrides via the `envOverrides` argument

import type { FastifyInstance } from 'fastify'
import { inject } from 'vitest'

import { buildApp as buildAppReal } from '../../src/app.js'
import { loadConfig } from '../../src/config/load.js'

const APP_TEST_DEFAULTS: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: '3001',
  HOST: '127.0.0.1',
  LOG_LEVEL: 'warn',

  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters-long',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters-long',
  JWT_ISSUER: 'http://localhost:3001',

  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:3000/api/auth/google/callback',

  CORS_ORIGIN: 'http://localhost:3000',
}

const INFRA_INJECT = {
  DB_HOST: 'TEST_DB_HOST',
  DB_PORT: 'TEST_DB_PORT',
  DB_USER: 'TEST_DB_USER',
  DB_PASSWORD: 'TEST_DB_PASSWORD',
  DB_NAME: 'TEST_DB_NAME',
  DB_SCHEMA: 'TEST_DB_SCHEMA',
  DATABASE_URL: 'TEST_DATABASE_URL',
  REDIS_URL: 'TEST_REDIS_URL',
} as const

function injectRequired(key: (typeof INFRA_INJECT)[keyof typeof INFRA_INJECT]): string {
  try {
    const v = inject(key)
    if (typeof v === 'string' && v.length > 0) return v
  } catch {
    /* fall through */
  }
  throw new Error(
    `tests/helpers/app.ts: required testcontainer value "${key}" missing — ` +
      `did tests/setup/global-setup.ts run?`,
  )
}

export async function buildApp(
  envOverrides: Record<string, string> = {},
): Promise<FastifyInstance> {
  Object.assign(process.env, APP_TEST_DEFAULTS)
  for (const [envKey, provideKey] of Object.entries(INFRA_INJECT)) {
    process.env[envKey] = injectRequired(provideKey)
  }
  Object.assign(process.env, envOverrides)
  const config = loadConfig({ readDotenv: false })
  return buildAppReal(config)
}
