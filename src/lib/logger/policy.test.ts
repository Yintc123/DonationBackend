import { describe, expect, it } from 'vitest'

import { shouldSkipRequestLog } from './policy.js'

describe('shouldSkipRequestLog (spec 004 §6.2)', () => {
  it('skips CORS preflight (spec 012 §3.6)', () => {
    expect(
      shouldSkipRequestLog({
        method: 'OPTIONS',
        url: '/v1/auth/login',
        routeOptions: { url: '/v1/auth/login' },
      } as never),
    ).toBe(true)
  })

  it('skips /health/* by resolved route URL', () => {
    expect(
      shouldSkipRequestLog({
        method: 'GET',
        url: '/health/live',
        routeOptions: { url: '/health/live' },
      } as never),
    ).toBe(true)
  })

  it('skips bare /health diagnostic endpoint', () => {
    expect(
      shouldSkipRequestLog({
        method: 'GET',
        url: '/health',
        routeOptions: { url: '/health' },
      } as never),
    ).toBe(true)
  })

  it('skips /health/* even on 404 (no resolved route)', () => {
    expect(
      shouldSkipRequestLog({
        method: 'GET',
        url: '/health/unknown',
        routeOptions: undefined,
      } as never),
    ).toBe(true)
  })

  it('does NOT skip ordinary GET on a real route', () => {
    expect(
      shouldSkipRequestLog({
        method: 'GET',
        url: '/v1/accounts/me',
        routeOptions: { url: '/v1/accounts/me' },
      } as never),
    ).toBe(false)
  })

  it('does NOT skip a path that merely starts with "health" but not with the prefix', () => {
    expect(
      shouldSkipRequestLog({
        method: 'GET',
        url: '/healthy',
        routeOptions: { url: '/healthy' },
      } as never),
    ).toBe(false)
  })
})
