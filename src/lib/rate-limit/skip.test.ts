// Spec 010 §9.1 — exemption predicate.
// Spec 012 §3.6 — preflight OPTIONS MUST be exempt (covered here, since
// spec 010 §3.6 cross-references and §9.1 owns the consolidated list).

import { describe, expect, it } from 'vitest'

import { shouldSkipRateLimit } from './skip.js'

function req(over: Partial<{ method: string; url: string; routerPath: string }>) {
  return {
    method: over.method ?? 'GET',
    url: over.url ?? '/v1/something',
    routerPath: over.routerPath,
  }
}

describe('shouldSkipRateLimit', () => {
  it('skips CORS preflight OPTIONS on any path (spec 012 §3.6 / spec 010 §3.6)', () => {
    expect(shouldSkipRateLimit(req({ method: 'OPTIONS', url: '/v1/anything' }))).toBe(true)
    expect(shouldSkipRateLimit(req({ method: 'OPTIONS', url: '/health/live' }))).toBe(true)
  })

  it('skips all six /health/* endpoints (spec 010 §9.1)', () => {
    const paths = [
      '/health',
      '/health/live',
      '/health/ready',
      '/health/startup',
      '/health/db',
      '/health/cache',
    ]
    for (const p of paths) {
      expect(shouldSkipRateLimit(req({ method: 'GET', url: p }))).toBe(true)
    }
  })

  it('uses routerPath when available (handles query strings)', () => {
    expect(
      shouldSkipRateLimit(
        req({ method: 'GET', url: '/health/live?check=1', routerPath: '/health/live' }),
      ),
    ).toBe(true)
  })

  it('does NOT skip arbitrary paths whose prefix coincidentally contains "health"', () => {
    expect(shouldSkipRateLimit(req({ method: 'GET', url: '/v1/healthcare' }))).toBe(false)
    expect(shouldSkipRateLimit(req({ method: 'GET', url: '/healthx' }))).toBe(false)
  })

  it('does not skip normal traffic', () => {
    expect(shouldSkipRateLimit(req({ method: 'POST', url: '/v1/auth/login' }))).toBe(false)
    expect(shouldSkipRateLimit(req({ method: 'GET', url: '/v1/profile' }))).toBe(false)
  })
})
