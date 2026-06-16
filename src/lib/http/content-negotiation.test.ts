// Spec 009 §9 — Accept + Content-Type validation.
//
// Pure-function unit tests for the request-time guard. Integration with
// Fastify (the onRequest hook in `plugin.ts`) is exercised in the existing
// reply-decorators / plugin integration tests.

import { describe, expect, it } from 'vitest'

import {
  isAcceptable,
  isJsonContentType,
  requestHasBody,
} from './content-negotiation.js'

describe('isAcceptable (spec 009 §9.1)', () => {
  it('returns true when Accept header is missing (caller takes whatever)', () => {
    expect(isAcceptable(undefined)).toBe(true)
  })

  it('returns true when Accept includes application/json', () => {
    expect(isAcceptable('application/json')).toBe(true)
    expect(isAcceptable('application/json; charset=utf-8')).toBe(true)
    expect(isAcceptable('text/html, application/json;q=0.9')).toBe(true)
  })

  it('returns true when Accept is */*', () => {
    expect(isAcceptable('*/*')).toBe(true)
  })

  it('returns true when Accept includes application/*', () => {
    expect(isAcceptable('application/*')).toBe(true)
  })

  it('returns true when Accept includes problem+json (errors)', () => {
    // RFC 7807 — clients that prefer problem+json should still get success
    // JSON. We map this as acceptable so client setups like
    // `Accept: application/problem+json, application/json` pass.
    expect(isAcceptable('application/problem+json, application/json')).toBe(true)
  })

  it('returns false when Accept is a non-json media type only', () => {
    expect(isAcceptable('text/html')).toBe(false)
    expect(isAcceptable('text/plain')).toBe(false)
    expect(isAcceptable('application/xml')).toBe(false)
  })

  it('handles whitespace and array-style Accept (Fastify passes string[] for repeated)', () => {
    expect(isAcceptable('  application/json  ')).toBe(true)
    expect(isAcceptable(['text/html', 'application/json'])).toBe(true)
    expect(isAcceptable(['text/html'])).toBe(false)
  })
})

describe('isJsonContentType (spec 009 §9.2)', () => {
  it('returns true when Content-Type starts with application/json', () => {
    expect(isJsonContentType('application/json')).toBe(true)
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true)
    expect(isJsonContentType('APPLICATION/JSON')).toBe(true)
  })

  it('returns false when Content-Type is anything else', () => {
    expect(isJsonContentType('text/plain')).toBe(false)
    expect(isJsonContentType('multipart/form-data; boundary=xyz')).toBe(false)
    expect(isJsonContentType('application/xml')).toBe(false)
    expect(isJsonContentType(undefined)).toBe(false)
    expect(isJsonContentType('')).toBe(false)
  })
})

describe('requestHasBody', () => {
  it('returns false when Content-Length is "0" or missing without Transfer-Encoding', () => {
    expect(requestHasBody({ 'content-length': '0' })).toBe(false)
    expect(requestHasBody({})).toBe(false)
  })

  it('returns true when Content-Length > 0', () => {
    expect(requestHasBody({ 'content-length': '5' })).toBe(true)
  })

  it('returns true when Transfer-Encoding: chunked (length unknown but body coming)', () => {
    expect(requestHasBody({ 'transfer-encoding': 'chunked' })).toBe(true)
  })
})
