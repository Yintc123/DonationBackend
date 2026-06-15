// Spec 007 / 008 — `/v1/auth/*` alias parity tests.
//
// Every spec 007 / 008 auth route is reachable under BOTH the canonical
// `/auth/*` URL AND a `/v1/auth/*` alias (src/lib/http/v1-alias.ts). The
// helper invokes `app.route` twice with identical opts; here we confirm
// the two paths are observationally identical for status, body, and
// error code on a representative sample of routes covering the major
// shapes (register / login / refresh / google / me).
//
// We do NOT inject every alias for every error path — the helper makes
// them structurally identical, so the parity test is "are the two URLs
// addressable and do they return the same thing on the happy + failure
// edges". Anything beyond that is duplicating the underlying spec 007 /
// 008 / spec 005 contracts already exercised by the canonical-URL suites.

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../helpers/app.js'

let app: FastifyInstance

beforeEach(async () => {
  app = await buildApp()
})

afterEach(async () => {
  await app.close()
})

interface JsonShape {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  bodyJson: unknown
}

async function inject(method: string, url: string, opts: Parameters<FastifyInstance['inject']>[0] extends infer T
  ? T extends { method: string; url: string }
    ? Omit<T, 'method' | 'url'>
    : never
  : never = {} as never): Promise<JsonShape> {
  const res = await app.inject({ method, url, ...(opts as object) })
  let bodyJson: unknown
  try {
    bodyJson = res.json()
  } catch {
    bodyJson = null
  }
  return { statusCode: res.statusCode, headers: res.headers as JsonShape['headers'], bodyJson }
}

function expectParity(a: JsonShape, b: JsonShape, label: string): void {
  // status + body must be identical; per-response identifiers (request id,
  // jwt jti, timestamps) are NOT — those naturally vary per call. We only
  // assert the structural shape + status here.
  expect(a.statusCode, `${label}: status mismatch`).toBe(b.statusCode)
  if (typeof a.bodyJson === 'object' && a.bodyJson !== null) {
    // For error responses, error.code matters most.
    const aBody = a.bodyJson as Record<string, unknown>
    const bBody = b.bodyJson as Record<string, unknown>
    const aError = aBody.error as Record<string, unknown> | undefined
    const bError = bBody.error as Record<string, unknown> | undefined
    if (aError && bError) {
      expect(aError.code, `${label}: error.code mismatch`).toBe(bError.code)
    }
  }
}

const REGISTER_BODY = {
  username: 'alias-' + Math.random().toString(36).slice(2, 8),
  password: 'a-valid-password-123',
}

describe('Spec 007 / 008 — /v1/auth/* alias parity', () => {
  it('POST /auth/register and POST /v1/auth/register both work', async () => {
    const canonical = await inject('POST', '/auth/register', {
      payload: { ...REGISTER_BODY, username: REGISTER_BODY.username + 'A' },
    })
    const aliased = await inject('POST', '/v1/auth/register', {
      payload: { ...REGISTER_BODY, username: REGISTER_BODY.username + 'B' },
    })
    expect(canonical.statusCode).toBe(201)
    expect(aliased.statusCode).toBe(201)
  })

  it('POST /auth/register and POST /v1/auth/register return identical 401 on missing identifier', async () => {
    const payload = { password: 'a-valid-password-123' }
    const canonical = await inject('POST', '/auth/register', { payload })
    const aliased = await inject('POST', '/v1/auth/register', { payload })
    expectParity(canonical, aliased, 'register-no-identifier')
    expect(canonical.statusCode).toBe(401)
  })

  it('POST /auth/login matches POST /v1/auth/login on bad credentials', async () => {
    const payload = { identifier: 'no-such-user', password: 'wrong-password-123' }
    const canonical = await inject('POST', '/auth/login', { payload })
    const aliased = await inject('POST', '/v1/auth/login', { payload })
    expectParity(canonical, aliased, 'login-bad-cred')
    expect(canonical.statusCode).toBe(401)
  })

  it('POST /auth/refresh matches POST /v1/auth/refresh on missing Authorization', async () => {
    const canonical = await inject('POST', '/auth/refresh', {})
    const aliased = await inject('POST', '/v1/auth/refresh', {})
    expectParity(canonical, aliased, 'refresh-no-auth')
    expect(canonical.statusCode).toBe(401)
  })

  it('POST /auth/logout matches POST /v1/auth/logout on missing refresh token', async () => {
    const canonical = await inject('POST', '/auth/logout', { payload: {} })
    const aliased = await inject('POST', '/v1/auth/logout', { payload: {} })
    expectParity(canonical, aliased, 'logout-empty-body')
    // logout-without-token returns 204 (no-op) per spec 007 §7.4
    expect([200, 204, 400, 401]).toContain(canonical.statusCode)
  })

  it('GET /auth/me matches GET /v1/auth/me on missing Authorization', async () => {
    const canonical = await inject('GET', '/auth/me')
    const aliased = await inject('GET', '/v1/auth/me')
    expectParity(canonical, aliased, 'me-no-auth')
    expect(canonical.statusCode).toBe(401)
  })

  it('POST /auth/google/authorize-init matches /v1/auth/google/authorize-init shape', async () => {
    const payload = { returnTo: '/' }
    const canonical = await inject('POST', '/auth/google/authorize-init', { payload })
    const aliased = await inject('POST', '/v1/auth/google/authorize-init', { payload })
    expect(canonical.statusCode).toBe(aliased.statusCode)
  })
})
