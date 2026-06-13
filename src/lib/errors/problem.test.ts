// Spec 005 §6 — RFC 7807 Problem Details serialiser.
//
// Pure function — no Fastify dependency, no IO. Given an AppError + context
// (instance path, requestId), produce the response body. The Fastify plugin
// adds the Content-Type header.

import { describe, expect, it } from 'vitest'

import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
  TooManyRequestsError,
  ValidationError,
} from './AppError.js'
import { toProblem } from './problem.js'

describe('toProblem (spec 005 §6.1)', () => {
  const ctx = { instance: '/v1/resources', requestId: 'req-123' }

  it('should produce title / status / code / instance / requestId for a 4xx error', () => {
    const err = new BadRequestError({ message: 'invalid field' })

    const body = toProblem(err, ctx)

    expect(body).toMatchObject({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      code: 'BAD_REQUEST',
      instance: '/v1/resources',
      requestId: 'req-123',
    })
  })

  it('should derive type URI from code in kebab-case (spec §6.1)', () => {
    const err = new NotFoundError({ resource: 'user', id: 'abc' })

    const body = toProblem(err, ctx)

    expect(body.type).toBe('about:blank')
    // type is conventionally URI; keep a fallback when no docsBaseUrl is given
    // but with docsBaseUrl we expect kebab-case derived path
    const body2 = toProblem(err, { ...ctx, docsBaseUrl: 'https://api.example.com' })
    expect(body2.type).toBe('https://api.example.com/errors/not-found')
  })

  it('should include details for ValidationError (spec §6.3 example)', () => {
    const err = new ValidationError({
      errors: [{ path: '/email', message: 'must be email', code: 'format.email' }],
    })

    const body = toProblem(err, { instance: '/v1/resources', requestId: 'req-123' })

    expect(body.details).toEqual({
      errors: [{ path: '/email', message: 'must be email', code: 'format.email' }],
    })
  })

  it('should include detail (human-readable) field from message when expose=true', () => {
    const err = new ConflictError({ message: 'Email already taken' })

    const body = toProblem(err, ctx)

    expect(body.detail).toBe('Email already taken')
  })

  it('should hide detail and rewrite title for 5xx when expose=false (spec §6.2)', () => {
    const err = new InternalError({ message: 'database exploded', cause: new Error('boom') })

    const body = toProblem(err, ctx)

    expect(body.title).toBe('Internal Server Error')
    expect(body.status).toBe(500)
    expect(body.code).toBe('INTERNAL_ERROR')
    // 5xx with expose=false MUST NOT leak message in detail (spec §6.2 / §11.1)
    expect(body.detail).toBeUndefined()
    expect(body.details).toBeUndefined()
  })

  it('should include retryAfter detail for TooManyRequestsError', () => {
    const err = new TooManyRequestsError({ retryAfter: 30 })

    const body = toProblem(err, ctx)

    expect(body.details).toEqual({ retryAfter: 30 })
  })

  it('should never leak query string in instance (spec §6.2)', () => {
    const err = new BadRequestError()
    const body = toProblem(err, { instance: '/v1/x?secret=abc', requestId: 'r' })
    expect(body.instance).toBe('/v1/x')
  })
})
