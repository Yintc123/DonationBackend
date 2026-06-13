// Spec 013 §8.2 — test harness around src/app.ts buildApp().
// Injects spec 001 §4.3 required env vars (overridable per call) so the real
// config loader runs in tests (per spec 013 §8.2 — do NOT mock loaders).
//
// Infrastructure connection info (DB_*, REDIS_URL) is sourced from the
// testcontainers via inject(), not the hardcoded fallbacks. Hardcoded
// values remain for unit tests that boot buildApp without globalSetup.

import type { FastifyInstance } from 'fastify'
import { inject } from 'vitest'

import { buildApp as buildAppReal } from '../../src/app.js'
import { loadConfig } from '../../src/config/load.js'

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

function tryInject(key: (typeof INFRA_INJECT)[keyof typeof INFRA_INJECT]): string | undefined {
  try {
    return inject(key)
  } catch {
    return undefined
  }
}

export async function buildApp(
  envOverrides: Record<string, string> = {},
): Promise<FastifyInstance> {
  Object.assign(process.env, TEST_ENV)
  // Live testcontainer values override the hardcoded defaults when present.
  for (const [envKey, provideKey] of Object.entries(INFRA_INJECT)) {
    const v = tryInject(provideKey)
    if (v) process.env[envKey] = v
  }
  Object.assign(process.env, envOverrides)
  const config = loadConfig({ readDotenv: false })
  return buildAppReal(config)
}
