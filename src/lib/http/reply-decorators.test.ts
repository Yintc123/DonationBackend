// Spec 009 — Fastify reply decorators that bake the success conventions in:
//   - reply.ok          (§3.1 200 + resource body)
//   - reply.created     (§3.1 201 + Location header)
//   - reply.accepted    (§3.1 202 + body containing taskId or polling URL)
//   - reply.noContent   (§3.1 204 + empty body)
//   - reply.paginated   (§5.3 200 + { items, pageInfo } envelope)
//
// Plus an `onSend` hook propagating `X-Request-Id` per §6.1.
//
// Tests use a disposable Fastify instance via `fastify.inject()` so we do not
// depend on buildApp() (per task constraint).

import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import httpResponsePlugin from './plugin.js'

describe('http response plugin', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = Fastify()
    await app.register(httpResponsePlugin)
  })

  afterEach(async () => {
    await app.close()
  })

  describe('reply.ok', () => {
    it('should respond 200 with the given resource body and JSON Content-Type (spec 009 §3.1, §4.1)', async () => {
      app.get('/r', async (_req, reply) => reply.ok({ id: 'abc', name: 'Example' }))

      const res = await app.inject({ method: 'GET', url: '/r' })

      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      expect(res.json()).toEqual({ id: 'abc', name: 'Example' })
    })
  })

  describe('reply.created', () => {
    it('should respond 201 with body and a Location header (spec 009 §3.1, §6.2)', async () => {
      app.post('/r', async (_req, reply) =>
        reply.created('/v1/resources/ghi789', { id: 'ghi789', name: 'New' }),
      )

      const res = await app.inject({ method: 'POST', url: '/r' })

      expect(res.statusCode).toBe(201)
      expect(res.headers.location).toBe('/v1/resources/ghi789')
      expect(res.json()).toEqual({ id: 'ghi789', name: 'New' })
    })
  })

  describe('reply.accepted', () => {
    it('should respond 202 with the given async task body (spec 009 §3.1)', async () => {
      app.post('/r/:id/action', async (_req, reply) =>
        reply.accepted({ taskId: 'task-1', statusUrl: '/v1/tasks/task-1' }),
      )

      const res = await app.inject({ method: 'POST', url: '/r/1/action' })

      expect(res.statusCode).toBe(202)
      expect(res.json()).toEqual({ taskId: 'task-1', statusUrl: '/v1/tasks/task-1' })
    })
  })

  describe('reply.noContent', () => {
    it('should respond 204 with an empty body (spec 009 §3.1 — body MUST be empty)', async () => {
      app.delete('/r/:id', async (_req, reply) => reply.noContent())

      const res = await app.inject({ method: 'DELETE', url: '/r/1' })

      expect(res.statusCode).toBe(204)
      expect(res.body).toBe('')
    })
  })

  describe('reply.paginated', () => {
    it('should respond 200 with { items, pageInfo } envelope (spec 009 §5.3)', async () => {
      app.get('/r', async (_req, reply) =>
        reply.paginated({
          items: [{ id: '1' }, { id: '2' }],
          nextCursor: 'opaque',
          hasMore: true,
        }),
      )

      const res = await app.inject({ method: 'GET', url: '/r' })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        items: [{ id: '1' }, { id: '2' }],
        pageInfo: { nextCursor: 'opaque', hasMore: true },
      })
    })

    it('should force nextCursor to null when hasMore is false (spec 009 §5.3 invariant)', async () => {
      app.get('/r', async (_req, reply) =>
        reply.paginated({ items: [], nextCursor: 'stale', hasMore: false }),
      )

      const res = await app.inject({ method: 'GET', url: '/r' })

      expect(res.json()).toEqual({
        items: [],
        pageInfo: { nextCursor: null, hasMore: false },
      })
    })
  })

  describe('X-Request-Id header propagation (spec 009 §6.1)', () => {
    it('should set X-Request-Id on every response, matching the Fastify request id', async () => {
      app.get('/r', async (_req, reply) => reply.ok({ id: 'abc' }))

      const res = await app.inject({ method: 'GET', url: '/r' })

      expect(res.headers['x-request-id']).toBeDefined()
      expect(typeof res.headers['x-request-id']).toBe('string')
      expect((res.headers['x-request-id'] as string).length).toBeGreaterThan(0)
    })

    it('should echo an incoming x-request-id header back on the response', async () => {
      app.get('/r', async (_req, reply) => reply.ok({ id: 'abc' }))
      const incoming = 'c4b7a5e0-8d9a-4f1f-9b3a-0e2a1b9d7f23'

      const res = await app.inject({
        method: 'GET',
        url: '/r',
        headers: { 'x-request-id': incoming },
      })

      expect(res.headers['x-request-id']).toBe(incoming)
    })

    it('should set X-Request-Id even on 204 No Content', async () => {
      app.delete('/r/:id', async (_req, reply) => reply.noContent())

      const res = await app.inject({ method: 'DELETE', url: '/r/1' })

      expect(res.statusCode).toBe(204)
      expect(res.headers['x-request-id']).toBeDefined()
    })

    it('should DROP a non-UUIDv4 inbound id and substitute Fastify request.id (spec 004 §6.3)', async () => {
      app.get('/r', async (_req, reply) => reply.ok({ id: 'abc' }))

      const res = await app.inject({
        method: 'GET',
        url: '/r',
        headers: { 'x-request-id': 'not-a-uuid' },
      })

      expect(res.headers['x-request-id']).not.toBe('not-a-uuid')
      expect(typeof res.headers['x-request-id']).toBe('string')
      expect((res.headers['x-request-id'] as string).length).toBeGreaterThan(0)
    })

    it('should reject a UUID v1 to prevent caller forging trace prefixes', async () => {
      app.get('/r', async (_req, reply) => reply.ok({ id: 'abc' }))
      // v1 UUID: 3rd block starts with `1`, not `4`.
      const v1 = 'c4b7a5e0-8d9a-1f1f-9b3a-0e2a1b9d7f23'

      const res = await app.inject({
        method: 'GET',
        url: '/r',
        headers: { 'x-request-id': v1 },
      })

      expect(res.headers['x-request-id']).not.toBe(v1)
    })

    it('should reject a log-injection payload smuggled in the header', async () => {
      app.get('/r', async (_req, reply) => reply.ok({ id: 'abc' }))
      const injection = 'real-id\nfake=admin user=root'

      const res = await app.inject({
        method: 'GET',
        url: '/r',
        headers: { 'x-request-id': injection },
      })

      expect(res.headers['x-request-id']).not.toContain('\n')
      expect(res.headers['x-request-id']).not.toBe(injection)
    })
  })
})
