// Spec 007 §8.2 — OIDC discovery + JWKS cache.
//
// Lifecycle (lazy):
//   getJwks()
//     ├─ if no jwks cached:
//     │    └─ fetch OIDC_DISCOVERY_URL → parse → fetch jwks_uri → cache
//     └─ return cached
//   refresh()
//     └─ force re-fetch (kid miss in verifier triggers this)
//
// Per spec §8.2 we put the cache in-memory: each instance handles a small
// volume of OIDC traffic, so we accept a brief warm-up on cold start.
//
// We deliberately do NOT pre-warm at app boot — the verifier path triggers
// it on first use. This also keeps integration tests deterministic since
// they can wire fresh MSW handlers before the first verify call.

import type { GoogleJwkSet } from './id-token.js'

export interface OidcDiscovery {
  /** Returns the cached JWKS, fetching it the first time. */
  getJwks(): Promise<GoogleJwkSet>
  /** Forces a re-fetch — used when the verifier hits a kid not in cache. */
  refresh(): Promise<GoogleJwkSet>
}

export interface OidcDiscoveryOptions {
  discoveryUrl: string
  /** Pluggable fetch — defaults to global `fetch` (Node 20+). */
  fetchImpl?: typeof fetch
}

interface DiscoveryDocument {
  jwks_uri?: string
  token_endpoint?: string
  issuer?: string
}

export function createOidcDiscovery(opts: OidcDiscoveryOptions): OidcDiscovery {
  const f = opts.fetchImpl ?? fetch
  let cachedJwks: GoogleJwkSet | undefined
  let cachedJwksUri: string | undefined

  async function loadDiscovery(): Promise<string> {
    if (cachedJwksUri) return cachedJwksUri
    const res = await f(opts.discoveryUrl)
    if (!res.ok) {
      throw new Error(`oidc discovery: ${opts.discoveryUrl} returned ${res.status}`)
    }
    const doc = (await res.json()) as DiscoveryDocument
    if (!doc.jwks_uri) {
      throw new Error('oidc discovery: response is missing jwks_uri')
    }
    cachedJwksUri = doc.jwks_uri
    return cachedJwksUri
  }

  async function fetchJwks(): Promise<GoogleJwkSet> {
    const uri = await loadDiscovery()
    const res = await f(uri)
    if (!res.ok) {
      throw new Error(`oidc discovery: ${uri} returned ${res.status}`)
    }
    const jwks = (await res.json()) as GoogleJwkSet
    if (!jwks || !Array.isArray(jwks.keys)) {
      throw new Error('oidc discovery: JWKS response is malformed')
    }
    return jwks
  }

  return {
    async getJwks() {
      if (!cachedJwks) {
        cachedJwks = await fetchJwks()
      }
      return cachedJwks
    },
    async refresh() {
      cachedJwks = await fetchJwks()
      return cachedJwks
    },
  }
}
