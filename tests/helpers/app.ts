// Spec 013 §8.2 — test harness around src/app.ts buildApp().
// Injects spec 001 §4.3 required env vars (overridable per call) so the real
// config loader runs in tests (per spec 013 §8.2 — do NOT mock loaders).

import type { FastifyInstance } from 'fastify'

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

export async function buildApp(
  envOverrides: Record<string, string> = {},
): Promise<FastifyInstance> {
  Object.assign(process.env, TEST_ENV, envOverrides)
  const config = loadConfig({ readDotenv: false })
  return buildAppReal(config)
}
