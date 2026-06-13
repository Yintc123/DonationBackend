// Spec 005 §3 — AppError base class + named subclasses.
//
// Each subclass MUST:
//   - default statusCode + code per spec §3.2 / §4.2.1
//   - expose default = (statusCode < 500)
//   - preserve cause chain via the native Error.cause
//   - accept overrides for message / code / details / cause

import { describe, expect, it } from 'vitest'

import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  GatewayTimeoutError,
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  UnprocessableEntityError,
  ValidationError,
} from './AppError.js'

describe('AppError', () => {
  it('should set name to subclass name, capture stack, default expose by statusCode', () => {
    const err = new AppError({
      message: 'something',
      statusCode: 418,
      code: 'I_AM_TEAPOT',
    })

    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('AppError')
    expect(err.message).toBe('something')
    expect(err.statusCode).toBe(418)
    expect(err.code).toBe('I_AM_TEAPOT')
    expect(err.expose).toBe(true) // < 500
    expect(typeof err.stack).toBe('string')
  })

  it('should default expose=false when statusCode is 5xx (spec §3.1)', () => {
    const err = new AppError({ message: 'boom', statusCode: 500, code: 'INTERNAL_ERROR' })
    expect(err.expose).toBe(false)
  })

  it('should allow explicit expose override (spec §3.1)', () => {
    const err = new AppError({
      message: 'boom',
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      expose: true,
    })
    expect(err.expose).toBe(true)
  })

  it('should preserve cause via Error.cause (Node 16+)', () => {
    const root = new Error('root')
    const wrapped = new AppError({
      message: 'wrapper',
      statusCode: 502,
      code: 'UPSTREAM_FAILURE',
      cause: root,
    })
    expect(wrapped.cause).toBe(root)
  })
})

describe('AppError subclasses (spec §3.2)', () => {
  it.each<[string, AppError, number, string]>([
    ['BadRequestError', new BadRequestError({ message: 'bad' }), 400, 'BAD_REQUEST'],
    ['ValidationError', new ValidationError({ errors: [] }), 400, 'VALIDATION_FAILED'],
    ['UnauthorizedError', new UnauthorizedError(), 401, 'UNAUTHORIZED'],
    ['ForbiddenError', new ForbiddenError(), 403, 'FORBIDDEN'],
    ['NotFoundError', new NotFoundError({ resource: 'user' }), 404, 'NOT_FOUND'],
    ['ConflictError', new ConflictError({ message: 'dup' }), 409, 'CONFLICT'],
    [
      'UnprocessableEntityError',
      new UnprocessableEntityError({ message: 'no' }),
      422,
      'UNPROCESSABLE_ENTITY',
    ],
    ['TooManyRequestsError', new TooManyRequestsError({ retryAfter: 10 }), 429, 'RATE_LIMITED'],
    ['InternalError', new InternalError(), 500, 'INTERNAL_ERROR'],
    ['ServiceUnavailableError', new ServiceUnavailableError(), 503, 'SERVICE_UNAVAILABLE'],
    ['GatewayTimeoutError', new GatewayTimeoutError(), 504, 'GATEWAY_TIMEOUT'],
  ])('%s should default to %s / %s', (name, err, status, code) => {
    expect(err.name).toBe(name)
    expect(err.statusCode).toBe(status)
    expect(err.code).toBe(code)
    expect(err.expose).toBe(status < 500)
  })

  it('NotFoundError should attach resource + id to details', () => {
    const err = new NotFoundError({ resource: 'user', id: 'abc' })
    expect(err.details).toEqual({ resource: 'user', id: 'abc' })
  })

  it('ValidationError should attach errors[] to details (spec §6.2)', () => {
    const errors = [{ path: '/email', message: 'must be email', code: 'format.email' }]
    const err = new ValidationError({ errors })
    expect(err.details).toEqual({ errors })
  })

  it('TooManyRequestsError should expose retryAfter in details (spec §3.2)', () => {
    const err = new TooManyRequestsError({ retryAfter: 30 })
    expect(err.details).toEqual({ retryAfter: 30 })
  })

  it('should allow custom code override on subclasses (spec §3.2 — "USER_EMAIL_TAKEN" use case)', () => {
    const err = new ConflictError({ message: 'email taken', code: 'AUTH_EMAIL_TAKEN' })
    expect(err.code).toBe('AUTH_EMAIL_TAKEN')
    expect(err.statusCode).toBe(409)
  })
})
