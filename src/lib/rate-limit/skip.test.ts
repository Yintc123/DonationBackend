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

  // Spec 016 §12.1 (B5) — @fastify/swagger-ui mounts the bundle under
  // /docs and serves its static assets via a wildcard route whose
  // routeOptions.url contains '*'. That wildcard would otherwise blow up
  // assertRouteSafe() in keys.ts and surface as 503 RATE_LIMIT_UNAVAILABLE.
  // Swagger UI is dev-only (the openapi plugin is a no-op in production), so
  // exempting /docs/* from rate-limit is safe and matches /health/* in
  // spirit: introspection / operator surface, not user-facing traffic.
  describe('/docs/* (Swagger UI, spec 016 §12.1)', () => {
    it('skips the bundle root and trailing-slash form', () => {
      expect(shouldSkipRateLimit(req({ method: 'GET', url: '/docs' }))).toBe(true)
      expect(shouldSkipRateLimit(req({ method: 'GET', url: '/docs/' }))).toBe(true)
    })

    it('skips static asset paths (.css, .js, .png)', () => {
      const assets = [
        '/docs/static/swagger-ui.css',
        '/docs/static/index.css',
        '/docs/static/swagger-ui-bundle.js',
        '/docs/static/swagger-ui-standalone-preset.js',
        '/docs/static/swagger-initializer.js',
        '/docs/static/favicon-32x32.png',
      ]
      for (const p of assets) {
        expect(shouldSkipRateLimit(req({ method: 'GET', url: p }))).toBe(true)
      }
    })

    it('skips the wildcard routerPath emitted by @fastify/static', () => {
      // Fastify resolves the static handler's routeOptions.url to a literal
      // '*'-bearing pattern; that string flows into our skip predicate.
      expect(
        shouldSkipRateLimit(
          req({
            method: 'GET',
            url: '/docs/static/swagger-ui.css',
            routerPath: '/docs/static/*',
          }),
        ),
      ).toBe(true)
    })

    it('skips /docs/json (the spec endpoint Swagger UI fetches)', () => {
      expect(shouldSkipRateLimit(req({ method: 'GET', url: '/docs/json' }))).toBe(true)
    })

    it('does NOT skip prefix look-alikes that are not under /docs', () => {
      expect(shouldSkipRateLimit(req({ method: 'GET', url: '/documents' }))).toBe(false)
      expect(shouldSkipRateLimit(req({ method: 'GET', url: '/docsx' }))).toBe(false)
      expect(shouldSkipRateLimit(req({ method: 'GET', url: '/v1/docs' }))).toBe(false)
    })
  })

  it('does not skip normal traffic', () => {
    expect(shouldSkipRateLimit(req({ method: 'POST', url: '/v1/auth/login' }))).toBe(false)
    expect(shouldSkipRateLimit(req({ method: 'GET', url: '/v1/profile' }))).toBe(false)
  })
})
