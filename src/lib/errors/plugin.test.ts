// Spec 005 §5 — Fastify global setErrorHandler plugin.
//
// Tests use a disposable Fastify instance via `fastify.inject()` so we don't
// depend on buildApp() (matches spec 009 plugin test pattern).
//
// What's covered (per spec 005 acceptance):
//   1. AppError → status + Problem Details body + application/problem+json
//   2. Fastify schema validation error → BadRequestError envelope (400)
//   3. Prisma P2002 thrown in a handler → ConflictError envelope (409)
//   4. Unknown thrown Error → opaque 500 (no message / no stack leaked)
//   5. requestId in body matches X-Request-Id header / request.id
//   6. Content-Type is application/problem+json on all error responses
//   7. The plugin is fastify-plugin'd so setErrorHandler escapes the encapsulation

import { Prisma } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  UnprocessableEntityError,
  ValidationError,
} from './AppError.js'
import errorHandlerPlugin from './plugin.js'

async function buildTestApp(opts: { docsBaseUrl?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(errorHandlerPlugin, opts)
  return app
}

describe('errorHandlerPlugin (spec 005 §5)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await buildTestApp()
  })

  afterEach(async () => {
    await app.close()
  })

  describe('AppError mapping (spec §3.2 / §6)', () => {
    it.each<[string, () => Error, number, string]>([
      ['BadRequestError', () => new BadRequestError({ message: 'bad' }), 400, 'BAD_REQUEST'],
      [
        'ValidationError',
        () => new ValidationError({ errors: [{ path: '/x', message: 'm', code: 'c' }] }),
        400,
        'VALIDATION_FAILED',
      ],
      ['UnauthorizedError', () => new UnauthorizedError(), 401, 'UNAUTHORIZED'],
      ['ForbiddenError', () => new ForbiddenError(), 403, 'FORBIDDEN'],
      [
        'NotFoundError',
        () => new NotFoundError({ resource: 'user', id: 'abc' }),
        404,
        'NOT_FOUND',
      ],
      ['ConflictError', () => new ConflictError({ message: 'dup' }), 409, 'CONFLICT'],
      [
        'UnprocessableEntityError',
        () => new UnprocessableEntityError({ message: 'rule failed' }),
        422,
        'UNPROCESSABLE_ENTITY',
      ],
      [
        'TooManyRequestsError',
        () => new TooManyRequestsError({ retryAfter: 30 }),
        429,
        'RATE_LIMITED',
      ],
    ])('%s should map to status %s with code %s', async (_name, factory, status, code) => {
      app.get('/throw', async () => {
        throw factory()
      })

      const res = await app.inject({ method: 'GET', url: '/throw' })

      expect(res.statusCode).toBe(status)
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/)
      const body = res.json()
      expect(body.code).toBe(code)
      expect(body.status).toBe(status)
      expect(body.instance).toBe('/throw')
      expect(body.requestId).toBe(res.headers['x-request-id'])
    })
  })

  describe('Fastify validation error (spec §8)', () => {
    it('should map Fastify schema validation error to ValidationError envelope', async () => {
      app.post(
        '/users',
        {
          schema: {
            body: {
              type: 'object',
              required: ['email'],
              properties: { email: { type: 'string', format: 'email' } },
            },
          },
        },
        async () => ({ ok: true }),
      )

      const res = await app.inject({
        method: 'POST',
        url: '/users',
        payload: { email: 'not-email' },
        headers: { 'content-type': 'application/json' },
      })

      expect(res.statusCode).toBe(400)
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/)
      const body = res.json()
      expect(body.code).toBe('VALIDATION_FAILED')
      expect(body.status).toBe(400)
      expect(Array.isArray(body.details?.errors)).toBe(true)
      expect(body.details.errors.length).toBeGreaterThan(0)
      // Each entry shaped per spec §8.2
      for (const entry of body.details.errors) {
        expect(entry).toHaveProperty('path')
        expect(entry).toHaveProperty('message')
        expect(entry).toHaveProperty('code')
      }
    })
  })

  describe('Prisma error mapping (spec §7.2)', () => {
    it('should map a P2002 thrown by a handler to ConflictError envelope', async () => {
      app.get('/throw-prisma', async () => {
        throw new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['email'] },
        })
      })

      const res = await app.inject({ method: 'GET', url: '/throw-prisma' })

      expect(res.statusCode).toBe(409)
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/)
      const body = res.json()
      expect(body.code).toBe('UNIQUE_CONSTRAINT')
      expect(body.details).toEqual({ fields: ['email'] })
    })

    it('should treat unknown Prisma P-code as programmer error (opaque 500)', async () => {
      app.get('/throw-unknown-prisma', async () => {
        throw new Prisma.PrismaClientKnownRequestError('mystery', {
          code: 'P9999',
          clientVersion: 'test',
        })
      })

      const res = await app.inject({ method: 'GET', url: '/throw-unknown-prisma' })

      expect(res.statusCode).toBe(500)
      const body = res.json()
      expect(body.code).toBe('INTERNAL_ERROR')
      expect(body.title).toBe('Internal Server Error')
      expect(body).not.toHaveProperty('detail')
      expect(body).not.toHaveProperty('details')
    })
  })

  describe('Programmer error path (spec §11.2)', () => {
    it('should convert a bare Error to opaque 500 INTERNAL_ERROR (no message leak)', async () => {
      app.get('/oops', async () => {
        throw new Error('database password is hunter2')
      })

      const res = await app.inject({ method: 'GET', url: '/oops' })

      expect(res.statusCode).toBe(500)
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/)
      const body = res.json()
      expect(body.code).toBe('INTERNAL_ERROR')
      expect(body.title).toBe('Internal Server Error')
      // Spec §11.1 — no message / stack / detail leaked in the envelope.
      expect(body.detail).toBeUndefined()
      expect(JSON.stringify(body)).not.toContain('hunter2')
      expect(JSON.stringify(body)).not.toContain('stack')
    })

    it('should also handle an InternalError thrown directly (no message exposed)', async () => {
      app.get('/oops', async () => {
        throw new InternalError({ message: 'shard down', cause: new Error('boom') })
      })

      const res = await app.inject({ method: 'GET', url: '/oops' })

      expect(res.statusCode).toBe(500)
      const body = res.json()
      expect(body.code).toBe('INTERNAL_ERROR')
      expect(JSON.stringify(body)).not.toContain('shard down')
    })
  })

  describe('X-Request-Id propagation (spec §6.2)', () => {
    it('should set requestId to match Fastify request.id by default', async () => {
      app.get('/throw', async () => {
        throw new BadRequestError({ message: 'x' })
      })

      const res = await app.inject({ method: 'GET', url: '/throw' })

      const headerId = res.headers['x-request-id']
      expect(headerId).toBeDefined()
      expect(res.json().requestId).toBe(headerId)
    })

    it('should reuse an inbound X-Request-Id header in the response body', async () => {
      app.get('/throw', async () => {
        throw new BadRequestError({ message: 'x' })
      })

      const inbound = 'c4b7a5e0-8d9a-4f1f-9b3a-0e2a1b9d7f23'
      const res = await app.inject({
        method: 'GET',
        url: '/throw',
        headers: { 'x-request-id': inbound },
      })

      expect(res.headers['x-request-id']).toBe(inbound)
      expect(res.json().requestId).toBe(inbound)
    })
  })

  describe('setNotFoundHandler (spec §5.3)', () => {
    it('should map unknown routes to RFC 7807 with code NOT_FOUND and status 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/does-not-exist' })

      expect(res.statusCode).toBe(404)
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/)
      const body = res.json()
      expect(body.code).toBe('NOT_FOUND')
      expect(body.status).toBe(404)
      expect(body.instance).toBe('/does-not-exist')
      // Spec §5.3 — the route doesn't exist, so the path itself is the
      // resource we name in details (callers can tell "unknown route" from
      // a domain 404 like "user not found" because resource === path).
      expect(body.details?.resource).toBe('/does-not-exist')
    })

    it('should propagate inbound X-Request-Id on 404 responses', async () => {
      const inbound = 'c4b7a5e0-8d9a-4f1f-9b3a-0e2a1b9d7f23'
      const res = await app.inject({
        method: 'GET',
        url: '/missing',
        headers: { 'x-request-id': inbound },
      })

      expect(res.statusCode).toBe(404)
      expect(res.headers['x-request-id']).toBe(inbound)
      expect(res.json().requestId).toBe(inbound)
    })

    it('should set Cache-Control: no-store on 404 (cascading visibility)', async () => {
      const res = await app.inject({ method: 'GET', url: '/missing' })
      expect(res.headers['cache-control']).toBe('no-store')
    })
  })

  describe('docsBaseUrl option (spec §6.1 type URI)', () => {
    it('should derive type URI from code when docsBaseUrl is configured', async () => {
      const customApp = await buildTestApp({ docsBaseUrl: 'https://api.example.com' })
      try {
        customApp.get('/throw', async () => {
          throw new NotFoundError({ resource: 'user' })
        })

        const res = await customApp.inject({ method: 'GET', url: '/throw' })

        expect(res.json().type).toBe('https://api.example.com/errors/not-found')
      } finally {
        await customApp.close()
      }
    })
  })
})
