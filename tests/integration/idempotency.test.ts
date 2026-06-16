// Spec 009 §7 — Idempotency-Key middleware (integration).
//
// Mounts a disposable POST endpoint on the real Fastify stack (helmet →
// errorHandler → http → rate-limit → idempotency → handler) and exercises
// the full request lifecycle against the testcontainer Redis. This lets us
// verify the hooks compose correctly with the spec 005 error pipeline and
// the spec 010 rate-limit pipeline.

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../helpers/app.js'

interface ProblemResponse {
  status: number
  code: string
  details?: { header?: string; reason?: string }
}

// A constant body that produces a predictable, deterministic counter so we
// can detect "did the handler run twice or did the plugin replay?".
let counter = 0

async function buildAppWithEcho(): Promise<FastifyInstance> {
  const app = await buildApp()
  app.get('/test/get', async (_req, reply) => reply.send({ ok: true }))
  app.post(
    '/test/echo',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['payload'],
          properties: { payload: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      counter += 1
      const body = req.body as { payload: string }
      return reply.code(201).header('location', '/test/echo/1').send({
        echoed: body.payload,
        counter,
      })
    },
  )
  app.post(
    '/test/required',
    { config: { idempotency: 'required' } },
    async (_req, reply) => reply.code(200).send({ ok: true }),
  )
  await app.ready()
  return app
}

describe('idempotencyPlugin (spec 009 §7, integration)', () => {
  let app: FastifyInstance | undefined
  beforeEach(() => {
    counter = 0
  })
  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('rejects malformed Idempotency-Key with 400 IDEMPOTENCY_KEY_INVALID (§7.4)', async () => {
    app = await buildAppWithEcho()
    const res = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'idempotency-key': 'not-a-uuid' },
      payload: { payload: 'hello' },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as ProblemResponse
    expect(body.code).toBe('IDEMPOTENCY_KEY_INVALID')
    expect(body.details?.reason).toBe('malformed')
    expect(counter).toBe(0)
  })

  it('without header, POST runs normally', async () => {
    app = await buildAppWithEcho()
    const res = await app.inject({
      method: 'POST',
      url: '/test/echo',
      payload: { payload: 'hello' },
    })
    expect(res.statusCode).toBe(201)
    expect(counter).toBe(1)
    expect(res.headers['x-idempotency-replay']).toBeUndefined()
  })

  it('replays a cached response on repeat (UUID v4, §7.3)', async () => {
    app = await buildAppWithEcho()
    const key = 'c4b7a5e0-8d9a-4f1f-9b3a-0e2a1b9d7f23'

    const a = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'idempotency-key': key },
      payload: { payload: 'hello' },
    })
    expect(a.statusCode).toBe(201)
    expect(counter).toBe(1)
    expect(a.json()).toMatchObject({ echoed: 'hello', counter: 1 })

    const b = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'idempotency-key': key },
      payload: { payload: 'hello' },
    })
    expect(b.statusCode).toBe(201)
    // Handler did NOT re-run (counter unchanged).
    expect(counter).toBe(1)
    expect(b.json()).toMatchObject({ echoed: 'hello', counter: 1 })
    expect(b.headers['x-idempotency-replay']).toBe('true')
    expect(b.headers['location']).toBe('/test/echo/1')
  })

  it('replays a cached response on repeat (ULID)', async () => {
    app = await buildAppWithEcho()
    const key = '01HBP3WM3KQH8ATZ8C8B05E5MN'

    await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'idempotency-key': key },
      payload: { payload: 'hello' },
    })
    const b = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'idempotency-key': key },
      payload: { payload: 'hello' },
    })
    expect(b.headers['x-idempotency-replay']).toBe('true')
    expect(counter).toBe(1)
  })

  it('same key, different body → 422 IDEMPOTENCY_KEY_CONFLICT (§7.4)', async () => {
    app = await buildAppWithEcho()
    const key = 'c4b7a5e0-8d9a-4f1f-9b3a-0e2a1b9d7f23'

    await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'idempotency-key': key },
      payload: { payload: 'first' },
    })
    const b = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'idempotency-key': key },
      payload: { payload: 'second' },
    })
    expect(b.statusCode).toBe(422)
    const body = b.json() as ProblemResponse
    expect(body.code).toBe('IDEMPOTENCY_KEY_CONFLICT')
    expect(counter).toBe(1) // only the first execution ran
  })

  it('does NOT cache 4xx responses — caller can retry with fixed body (§7.3)', async () => {
    app = await buildAppWithEcho()
    const key = 'c4b7a5e0-8d9a-4f1f-9b3a-0e2a1b9d7f23'

    const bad = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'idempotency-key': key },
      // Missing `payload` → schema 400.
      payload: { wrong: true },
    })
    expect(bad.statusCode).toBe(400)

    const good = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'idempotency-key': key },
      payload: { payload: 'hello' },
    })
    // 4xx was not cached, so this is the first real run, not a replay.
    expect(good.statusCode).toBe(201)
    expect(good.headers['x-idempotency-replay']).toBeUndefined()
    expect(counter).toBe(1)
  })

  it('GET (or any non-body method) ignores the header entirely', async () => {
    app = await buildAppWithEcho()
    const a = await app.inject({
      method: 'GET',
      url: '/test/get',
      headers: { 'idempotency-key': 'invalid' },
    })
    expect(a.statusCode).toBe(200)
  })

  it('config.idempotency: "required" rejects missing header with 400 (§7.1)', async () => {
    app = await buildAppWithEcho()
    const res = await app.inject({ method: 'POST', url: '/test/required' })
    expect(res.statusCode).toBe(400)
    const body = res.json() as ProblemResponse
    expect(body.code).toBe('IDEMPOTENCY_KEY_INVALID')
    expect(body.details?.reason).toBe('missing')
  })

  it('config.idempotency: "required" accepts a valid header', async () => {
    app = await buildAppWithEcho()
    const res = await app.inject({
      method: 'POST',
      url: '/test/required',
      headers: { 'idempotency-key': 'c4b7a5e0-8d9a-4f1f-9b3a-0e2a1b9d7f23' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('does NOT touch /health/* (spec 011 §8 + spec 009 §7)', async () => {
    app = await buildAppWithEcho()
    // /health/* has no body methods but verify the negative case anyway.
    const res = await app.inject({ method: 'GET', url: '/health/live' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-idempotency-replay']).toBeUndefined()
  })
})
