import { describe, expect, it } from 'vitest'

import { ConfigValidationError, postValidate } from './post-validate.js'
import type { Config } from './schema.js'

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

describe('postValidate', () => {
  it('passes with valid dev config (empty trusted proxies allowed)', () => {
    expect(() => postValidate(baseConfig)).not.toThrow()
  })

  it('rejects empty RATE_LIMIT_TRUSTED_PROXIES in staging', () => {
    expect(() =>
      postValidate({
        ...baseConfig,
        NODE_ENV: 'staging',
        RATE_LIMIT_TRUSTED_PROXIES: '',
      }),
    ).toThrow(ConfigValidationError)
  })

  it('rejects empty RATE_LIMIT_TRUSTED_PROXIES in production', () => {
    expect(() =>
      postValidate({
        ...baseConfig,
        NODE_ENV: 'production',
        RATE_LIMIT_TRUSTED_PROXIES: '',
      }),
    ).toThrow(/RATE_LIMIT_TRUSTED_PROXIES/)
  })

  it('accepts non-empty RATE_LIMIT_TRUSTED_PROXIES in production', () => {
    expect(() =>
      postValidate({
        ...baseConfig,
        NODE_ENV: 'production',
        RATE_LIMIT_TRUSTED_PROXIES: '10.0.0.0/8',
      }),
    ).not.toThrow()
  })

  it('rejects identical access and refresh secrets', () => {
    const secret = 'identical-secret-at-least-32-characters!'
    expect(() =>
      postValidate({
        ...baseConfig,
        JWT_ACCESS_SECRET: secret,
        JWT_REFRESH_SECRET: secret,
      }),
    ).toThrow(/must differ/)
  })
})
