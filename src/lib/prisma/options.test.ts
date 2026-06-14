import { describe, expect, it } from 'vitest'

import { buildPrismaClientOptions } from './options.js'
import type { Config } from '../../config/schema.js'

const BASE: Config = {
  NODE_ENV: 'development',
  PORT: 3001,
  HOST: '0.0.0.0',
  LOG_LEVEL: 'info',
  DB_HOST: 'db',
  DB_PORT: 5432,
  DB_USER: 'u',
  DB_PASSWORD: 'p',
  DB_NAME: 'n',
  DB_SCHEMA: 'public',
  DB_SSL_MODE: '',
  DB_CONNECTION_LIMIT: '',
  DB_POOL_TIMEOUT: '',
  DATABASE_URL: 'postgresql://u:p@db:5432/n?schema=public',
  REDIS_HOST: 'r',
  REDIS_PORT: 6379,
  REDIS_PASSWORD: '',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_ACCESS_EXPIRES_IN: '3h',
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  JWT_REFRESH_EXPIRES_IN: '30d',
  JWT_ISSUER: 'http://x',
  JWT_AUDIENCE: '',
  GOOGLE_CLIENT_ID: 'g',
  GOOGLE_CLIENT_SECRET: 's',
  GOOGLE_CALLBACK_URL: 'http://x/cb',
  OIDC_DISCOVERY_URL: 'http://x/.well-known',
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
  CORS_ORIGIN: 'http://x',
  CORS_PREFLIGHT_MAX_AGE_SEC: 600,
  HSTS_MAX_AGE_SEC: 31536000,
  HSTS_INCLUDE_SUBDOMAINS: true,
  HSTS_PRELOAD: false,
  S3_BUCKET: 'jko-donation-test-assets',
  S3_REGION: 'ap-northeast-1',
  S3_ENDPOINT: '',
  S3_FORCE_PATH_STYLE: 'false',
  S3_PUBLIC_URL_BASE: '',
  S3_PRESIGN_TTL_SECONDS: 300,
  S3_MAX_UPLOAD_BYTES: 5_242_880,
  AWS_ACCESS_KEY_ID: '',
  AWS_SECRET_ACCESS_KEY: '',
}

describe('buildPrismaClientOptions', () => {
  it('passes DATABASE_URL through as datasourceUrl', () => {
    expect(buildPrismaClientOptions(BASE)).toEqual({
      datasourceUrl: 'postgresql://u:p@db:5432/n?schema=public',
    })
  })
})
