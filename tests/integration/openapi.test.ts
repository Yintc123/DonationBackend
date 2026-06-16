// Spec 016 §12.1 v0.13 (B5) — OpenAPI doc surface, dev-only.
//
// Goal:
//   - `GET /openapi.json` returns the generated OpenAPI 3.0 doc (200) when
//     NODE_ENV ∈ {development, staging}.
//   - `GET /docs` renders Swagger UI (200 / 301-to-trailing-slash) in dev.
//   - Both routes return 404 in production — we MUST NOT leak schema to
//     attackers scanning prod.
//   - The doc reflects the actual Fastify route schemas (smoke: list +
//     detail endpoints appear in `paths`).

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../helpers/app.js'

let app: FastifyInstance | undefined

afterEach(async () => {
  if (app) await app.close()
  app = undefined
})

describe('OpenAPI surface — development', () => {
  beforeEach(async () => {
    app = await buildApp({ NODE_ENV: 'development' })
  })

  it('GET /openapi.json returns a valid OpenAPI 3.0 document', async () => {
    const res = await app!.inject({ method: 'GET', url: '/openapi.json' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    const body = res.json() as {
      openapi: string
      paths: Record<string, unknown>
    }
    expect(body.openapi).toMatch(/^3\./)
    // Smoke: spec 016 endpoints (public reads) under /user/v1 + admin
    // write endpoints (spec 020) under /cms (spec 023 surfaces).
    expect(body.paths['/user/v1/donation/charities']).toBeDefined()
    expect(body.paths['/user/v1/donation/charities/{id}']).toBeDefined()
    expect(body.paths['/user/v1/donation/donation-projects']).toBeDefined()
    expect(body.paths['/user/v1/donation/sale-items']).toBeDefined()
    expect(body.paths['/user/v1/donation/categories']).toBeDefined()
    expect(body.paths['/cms/donation/charities']).toBeDefined()
    expect(body.paths['/cms/donation/charities/{id}']).toBeDefined()
  })

  it('GET /docs renders the Swagger UI shell', async () => {
    const res = await app!.inject({ method: 'GET', url: '/docs/' })
    // swagger-ui returns 200 for the html shell.
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
  })
})

describe('OpenAPI surface — staging (also enabled)', () => {
  beforeEach(async () => {
    app = await buildApp({
      NODE_ENV: 'staging',
      // Required outside development (spec 001 §4.4 / spec 010 §15.1).
      RATE_LIMIT_TRUSTED_PROXIES: '10.0.0.0/8',
      // ADR 008: staging/prod use ECS task role; static AWS creds must be empty.
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
    })
  })

  it('staging still exposes /openapi.json (enabled when NODE_ENV !== production)', async () => {
    const res = await app!.inject({ method: 'GET', url: '/openapi.json' })
    expect(res.statusCode).toBe(200)
  })
})

describe('OpenAPI surface — production', () => {
  beforeEach(async () => {
    app = await buildApp({
      NODE_ENV: 'production',
      RATE_LIMIT_TRUSTED_PROXIES: '10.0.0.0/8',
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
    })
  })

  it('GET /openapi.json returns 404 in production (no schema leak)', async () => {
    const res = await app!.inject({ method: 'GET', url: '/openapi.json' })
    expect(res.statusCode).toBe(404)
  })

  it('GET /docs returns 404 in production', async () => {
    const res = await app!.inject({ method: 'GET', url: '/docs/' })
    expect(res.statusCode).toBe(404)
  })
})
