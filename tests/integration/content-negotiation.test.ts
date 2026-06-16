// Spec 009 §9 — Content negotiation guard (integration).
//
// Exercises the onRequest hook in `src/lib/http/plugin.ts` against a real
// app (so the path-skip and method-skip logic is verified end-to-end). The
// pure-function predicates are covered by content-negotiation.test.ts.

import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../helpers/app.js'

interface ProblemResponse {
  status: number
  code: string
  details?: { header?: string }
}

describe('content negotiation guard (spec 009 §9, integration)', () => {
  let app: FastifyInstance | undefined
  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('rejects Accept: text/html with 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/categories',
      headers: { accept: 'text/html' },
    })
    expect(res.statusCode).toBe(415)
    const body = res.json() as ProblemResponse
    expect(body.code).toBe('UNSUPPORTED_MEDIA_TYPE')
    expect(body.details?.header).toBe('Accept')
  })

  it('accepts Accept: */* (most browsers / curl)', async () => {
    app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/user/v1/donation/categories',
      headers: { accept: '*/*' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('accepts missing Accept header', async () => {
    app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/user/v1/donation/categories' })
    expect(res.statusCode).toBe(200)
  })

  it('rejects POST with body and Content-Type: text/plain (spec §9.2)', async () => {
    app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: { 'content-type': 'text/plain' },
      payload: 'not-json',
    })
    expect(res.statusCode).toBe(415)
    const body = res.json() as ProblemResponse
    expect(body.code).toBe('UNSUPPORTED_MEDIA_TYPE')
    expect(body.details?.header).toBe('Content-Type')
  })

  it('rejects POST with body and no Content-Type (spec §9.2)', async () => {
    app = await buildApp()
    // Fastify infers application/json automatically when `payload` is an
    // object, so we send a raw string and explicitly clear the header.
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: { 'content-type': '' },
      payload: 'not-json',
    })
    expect(res.statusCode).toBe(415)
  })

  it('accepts POST with Content-Type: application/json; charset=utf-8', async () => {
    app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: JSON.stringify({
        email: 'cn-test@example.com',
        password: 'correct-horse-stable',
      }),
    })
    // Either 201 (success) or some other non-415 status — what matters is the
    // negotiation guard did not refuse the media type. We assert it isn't 415.
    expect(res.statusCode).not.toBe(415)
  })

  it('does NOT enforce Content-Type on /health/* probes (spec 011 §8)', async () => {
    app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { accept: 'text/plain' },
    })
    // Health probes bypass the negotiation guard so a text/plain Accept
    // header (common for naïve uptime checkers) still gets a JSON body.
    expect(res.statusCode).toBe(200)
  })

  it('does NOT enforce on OPTIONS preflight (CORS owns it)', async () => {
    app = await buildApp()
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/user/v1/donation/categories',
      headers: {
        accept: 'text/html',
        origin: 'http://example.com',
        'access-control-request-method': 'GET',
      },
    })
    expect(res.statusCode).not.toBe(415)
  })
})
