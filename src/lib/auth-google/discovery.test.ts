// Spec 007 §8.2 — OIDC discovery + JWKS fetch with in-memory cache.
//
// Tests use MSW to intercept the outbound HTTPS requests (per spec 013 §8.3).

import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createOidcDiscovery } from './discovery.js'

const DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration'
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

function discoveryDoc(): Record<string, unknown> {
  return {
    issuer: 'https://accounts.google.com',
    jwks_uri: JWKS_URL,
    token_endpoint: TOKEN_ENDPOINT,
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  }
}

const FAKE_JWK_A = {
  kty: 'RSA' as const,
  use: 'sig',
  alg: 'RS256',
  kid: 'kid-a',
  n: 'n-value-a',
  e: 'AQAB',
}

const FAKE_JWK_B = {
  kty: 'RSA' as const,
  use: 'sig',
  alg: 'RS256',
  kid: 'kid-b',
  n: 'n-value-b',
  e: 'AQAB',
}

let jwksReturned: typeof FAKE_JWK_A[] = [FAKE_JWK_A]
let jwksFetchCount = 0
let discoveryFetchCount = 0

const server = setupServer(
  http.get(DISCOVERY_URL, () => {
    discoveryFetchCount++
    return HttpResponse.json(discoveryDoc())
  }),
  http.get(JWKS_URL, () => {
    jwksFetchCount++
    return HttpResponse.json({ keys: jwksReturned })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers(
    http.get(DISCOVERY_URL, () => {
      discoveryFetchCount++
      return HttpResponse.json(discoveryDoc())
    }),
    http.get(JWKS_URL, () => {
      jwksFetchCount++
      return HttpResponse.json({ keys: jwksReturned })
    }),
  )
  jwksReturned = [FAKE_JWK_A]
  jwksFetchCount = 0
  discoveryFetchCount = 0
})
afterAll(() => server.close())

describe('createOidcDiscovery (spec 007 §8.2)', () => {
  it('should fetch discovery + JWKS lazily on first getJwks() call', async () => {
    const disc = createOidcDiscovery({ discoveryUrl: DISCOVERY_URL })
    expect(jwksFetchCount).toBe(0)
    const jwks = await disc.getJwks()
    expect(jwks.keys).toHaveLength(1)
    expect(jwks.keys[0]?.kid).toBe('kid-a')
    expect(discoveryFetchCount).toBe(1)
    expect(jwksFetchCount).toBe(1)
  })

  it('should cache the JWKS across consecutive calls', async () => {
    const disc = createOidcDiscovery({ discoveryUrl: DISCOVERY_URL })
    await disc.getJwks()
    await disc.getJwks()
    await disc.getJwks()
    // Discovery and JWKS each fetched exactly once.
    expect(discoveryFetchCount).toBe(1)
    expect(jwksFetchCount).toBe(1)
  })

  it('should re-fetch the JWKS when refresh() is called (key rotation, §8.2)', async () => {
    const disc = createOidcDiscovery({ discoveryUrl: DISCOVERY_URL })
    await disc.getJwks()
    // Google rotates the key set.
    jwksReturned = [FAKE_JWK_B]
    const refreshed = await disc.refresh()
    expect(refreshed.keys[0]?.kid).toBe('kid-b')
    expect(jwksFetchCount).toBe(2)
  })
})
