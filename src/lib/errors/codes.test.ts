// Spec 005 §4.2 — Aggregate error-code dictionary.
//
// This file is the single source of truth (the spec OWNS the table; this
// module is the runtime mirror). The mapping `code → HTTP status` is part of
// the public contract and §4.4 forbids changes after release.

import { describe, expect, it } from 'vitest'

import { ErrorCode, ErrorCodeStatus } from './codes.js'

describe('Error code dictionary (spec 005 §4.2)', () => {
  it('should expose every code listed in spec §4.2.1 (generic)', () => {
    expect(ErrorCode.BAD_REQUEST).toBe('BAD_REQUEST')
    expect(ErrorCode.VALIDATION_FAILED).toBe('VALIDATION_FAILED')
    expect(ErrorCode.UNAUTHORIZED).toBe('UNAUTHORIZED')
    expect(ErrorCode.FORBIDDEN).toBe('FORBIDDEN')
    expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND')
    expect(ErrorCode.METHOD_NOT_ALLOWED).toBe('METHOD_NOT_ALLOWED')
    expect(ErrorCode.UNSUPPORTED_MEDIA_TYPE).toBe('UNSUPPORTED_MEDIA_TYPE')
    expect(ErrorCode.CONFLICT).toBe('CONFLICT')
    expect(ErrorCode.UNPROCESSABLE_ENTITY).toBe('UNPROCESSABLE_ENTITY')
    expect(ErrorCode.RATE_LIMITED).toBe('RATE_LIMITED')
    expect(ErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR')
    expect(ErrorCode.SERVICE_UNAVAILABLE).toBe('SERVICE_UNAVAILABLE')
    expect(ErrorCode.UPSTREAM_FAILURE).toBe('UPSTREAM_FAILURE')
    expect(ErrorCode.UPSTREAM_TIMEOUT).toBe('UPSTREAM_TIMEOUT')
    expect(ErrorCode.GATEWAY_TIMEOUT).toBe('GATEWAY_TIMEOUT')
  })

  it('should map each generic code to its spec §4.2.1 HTTP status', () => {
    expect(ErrorCodeStatus[ErrorCode.BAD_REQUEST]).toBe(400)
    expect(ErrorCodeStatus[ErrorCode.VALIDATION_FAILED]).toBe(400)
    expect(ErrorCodeStatus[ErrorCode.UNAUTHORIZED]).toBe(401)
    expect(ErrorCodeStatus[ErrorCode.FORBIDDEN]).toBe(403)
    expect(ErrorCodeStatus[ErrorCode.NOT_FOUND]).toBe(404)
    expect(ErrorCodeStatus[ErrorCode.METHOD_NOT_ALLOWED]).toBe(405)
    expect(ErrorCodeStatus[ErrorCode.CONFLICT]).toBe(409)
    expect(ErrorCodeStatus[ErrorCode.UNSUPPORTED_MEDIA_TYPE]).toBe(415)
    expect(ErrorCodeStatus[ErrorCode.UNPROCESSABLE_ENTITY]).toBe(422)
    expect(ErrorCodeStatus[ErrorCode.RATE_LIMITED]).toBe(429)
    expect(ErrorCodeStatus[ErrorCode.INTERNAL_ERROR]).toBe(500)
    expect(ErrorCodeStatus[ErrorCode.UPSTREAM_FAILURE]).toBe(502)
    expect(ErrorCodeStatus[ErrorCode.SERVICE_UNAVAILABLE]).toBe(503)
    expect(ErrorCodeStatus[ErrorCode.GATEWAY_TIMEOUT]).toBe(504)
    expect(ErrorCodeStatus[ErrorCode.UPSTREAM_TIMEOUT]).toBe(504)
  })
})
