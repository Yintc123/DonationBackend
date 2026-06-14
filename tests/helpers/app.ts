// Spec 013 §8.2 — test harness around src/app.ts buildApp().
//
// Test env isolation policy:
//
// Vitest, via Vite's loadEnv, auto-populates process.env with values from
// `.env` (and `.env.local`, `.env.test*` if present). That is a real-world
// hazard: any sensitive dev var (e.g. REDIS_PASSWORD, AWS_ACCESS_KEY_ID)
// would silently leak into the test process and override the test-only
// defaults we set here. We have already been bitten by REDIS_PASSWORD
// leaking and causing ioredis to send AUTH against a no-auth testcontainer.
//
// Fix: scrub EVERY known config key from process.env on each buildApp()
// call, THEN apply APP_TEST_DEFAULTS + INFRA_INJECT + per-test overrides.
// `KNOWN_CONFIG_KEYS` is derived from the TypeBox schema, so adding a new
// env var to schema.ts is automatically covered — no future leak surface.
//
// We deliberately do NOT call vitest config knobs to disable .env loading;
// scrubbing is more robust because it survives any future load path (e.g.
// a transitive dep that calls dotenv at import time).

import type { FastifyInstance } from 'fastify'
import { inject } from 'vitest'

import { buildApp as buildAppReal } from '../../src/app.js'
import { loadConfig } from '../../src/config/load.js'
import { ConfigSchema } from '../../src/config/schema.js'

const KNOWN_CONFIG_KEYS = Object.keys(ConfigSchema.properties) as readonly string[]

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

  // Testcontainer Redis is unauthenticated.
  REDIS_PASSWORD: '',

  // Spec 018 — LocalStack S3 defaults for the test harness.
  S3_REGION: 'ap-northeast-1',
  S3_FORCE_PATH_STYLE: 'true',
  S3_PRESIGN_TTL_SECONDS: '300',
  S3_MAX_UPLOAD_BYTES: '5242880',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
}

const INFRA_INJECT = {
  DB_HOST: 'TEST_DB_HOST',
  DB_PORT: 'TEST_DB_PORT',
  DB_USER: 'TEST_DB_USER',
  DB_PASSWORD: 'TEST_DB_PASSWORD',
  DB_NAME: 'TEST_DB_NAME',
  DB_SCHEMA: 'TEST_DB_SCHEMA',
  DATABASE_URL: 'TEST_DATABASE_URL',
  REDIS_HOST: 'TEST_REDIS_HOST',
  REDIS_PORT: 'TEST_REDIS_PORT',
  S3_ENDPOINT: 'TEST_S3_ENDPOINT',
  S3_BUCKET: 'TEST_S3_BUCKET',
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
  // Step 1: scrub every schema-known key from process.env. Anything Vite /
  // dotenv / a transitive import slipped in is wiped out.
  for (const key of KNOWN_CONFIG_KEYS) {
    delete process.env[key]
  }

  // Step 2: apply explicit test defaults.
  Object.assign(process.env, APP_TEST_DEFAULTS)

  // Step 3: overlay infra coordinates from the live testcontainers.
  for (const [envKey, provideKey] of Object.entries(INFRA_INJECT)) {
    process.env[envKey] = injectRequired(provideKey)
  }

  // Step 4: per-test overrides (e.g. force a specific NODE_ENV).
  Object.assign(process.env, envOverrides)

  const config = loadConfig({ readDotenv: false })
  return buildAppReal(config)
}
