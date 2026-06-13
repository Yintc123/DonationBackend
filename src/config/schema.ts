// Spec 001 §4.3 — environment configuration JSON Schema.
// Uses TypeBox so the schema (for @fastify/env runtime validation) and the
// Config type (compile-time) share a single source of truth.
//
// Schema content is the literal contract from spec 001 §3 (all sections).
// Any drift between this file and spec 001 §3 / `.env.example` is a bug.

import { Type, type Static } from '@sinclair/typebox'

export const ConfigSchema = Type.Object({
  // === Server (spec 001 §3.1) ===
  NODE_ENV: Type.Union([
    Type.Literal('development'),
    Type.Literal('staging'),
    Type.Literal('production'),
  ]),
  PORT: Type.Number({ default: 3001 }),
  HOST: Type.String({ default: '0.0.0.0' }),
  LOG_LEVEL: Type.Union(
    [
      Type.Literal('fatal'),
      Type.Literal('error'),
      Type.Literal('warn'),
      Type.Literal('info'),
      Type.Literal('debug'),
      Type.Literal('trace'),
    ],
    { default: 'info' },
  ),

  // === Database (spec 001 §3.2) ===
  DB_HOST: Type.String({ minLength: 1 }),
  DB_PORT: Type.Number({ minimum: 1024, maximum: 65535 }),
  DB_USER: Type.String({ minLength: 1 }),
  DB_PASSWORD: Type.String({ minLength: 1 }),
  DB_NAME: Type.String({ minLength: 1 }),
  DB_SCHEMA: Type.String({ default: 'public' }),
  DB_SSL_MODE: Type.Union(
    [
      Type.Literal(''),
      Type.Literal('require'),
      Type.Literal('verify-ca'),
      Type.Literal('verify-full'),
    ],
    { default: '' },
  ),
  DB_CONNECTION_LIMIT: Type.String({ default: '' }),
  DB_POOL_TIMEOUT: Type.String({ default: '' }),
  DATABASE_URL: Type.String({ minLength: 1 }),

  // === Redis (spec 001 §3.3) ===
  REDIS_URL: Type.String({ minLength: 1 }),

  // === JWT (spec 001 §3.4 / ADR 004) ===
  JWT_ACCESS_SECRET: Type.String({ minLength: 32 }),
  JWT_ACCESS_EXPIRES_IN: Type.String({ default: '3h' }),
  JWT_REFRESH_SECRET: Type.String({ minLength: 32 }),
  JWT_REFRESH_EXPIRES_IN: Type.String({ default: '30d' }),
  JWT_ISSUER: Type.String({ minLength: 1 }),
  JWT_AUDIENCE: Type.String({ default: '' }),

  // === Google OAuth / OIDC (spec 001 §3.5) ===
  GOOGLE_CLIENT_ID: Type.String({ minLength: 1 }),
  GOOGLE_CLIENT_SECRET: Type.String({ minLength: 1 }),
  GOOGLE_CALLBACK_URL: Type.String({ minLength: 1 }),
  OIDC_DISCOVERY_URL: Type.String({
    default: 'https://accounts.google.com/.well-known/openid-configuration',
  }),

  // === Password (spec 001 §3.6 / spec 008) ===
  PASSWORD_HASH_MEMORY_COST: Type.Number({ default: 19456 }),
  PASSWORD_HASH_TIME_COST: Type.Number({ default: 2 }),
  PASSWORD_HASH_PARALLELISM: Type.Number({ default: 1 }),
  PASSWORD_MIN_LENGTH: Type.Number({ default: 8, minimum: 8, maximum: 256 }),
  LOGIN_LOCK_THRESHOLD: Type.Number({ default: 10, minimum: 1 }),
  LOGIN_LOCK_WINDOW_SEC: Type.Number({ default: 900, minimum: 60 }),

  // === Rate Limit (spec 001 §3.7 / spec 010) ===
  RATE_LIMIT_GLOBAL_PER_IP_LIMIT: Type.Number({ default: 600 }),
  RATE_LIMIT_GLOBAL_PER_IP_WINDOW_SEC: Type.Number({ default: 60 }),
  RATE_LIMIT_DEFAULT_LIMIT: Type.Number({ default: 120 }),
  RATE_LIMIT_DEFAULT_WINDOW_SEC: Type.Number({ default: 60 }),
  RATE_LIMIT_FAILURE_MODE: Type.Union([Type.Literal('closed'), Type.Literal('open')], {
    default: 'closed',
  }),
  RATE_LIMIT_TRUSTED_PROXIES: Type.String({ default: '' }),

  // === CORS / Security Headers (spec 001 §3.8 / spec 012) ===
  CORS_ORIGIN: Type.String({ minLength: 1 }),
  CORS_PREFLIGHT_MAX_AGE_SEC: Type.Number({ default: 600 }),
  HSTS_MAX_AGE_SEC: Type.Number({ default: 31536000 }),
  HSTS_INCLUDE_SUBDOMAINS: Type.Boolean({ default: true }),
  HSTS_PRELOAD: Type.Boolean({ default: false }),
})

export type Config = Static<typeof ConfigSchema>
