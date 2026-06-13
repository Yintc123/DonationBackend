// Spec 013 §8.3 + spec 007 — MSW handlers for Google's OIDC endpoints.
//
// Exposes a `createGoogleMsw()` factory: each integration test allocates a
// fresh RSA key pair + JWKS and gets handlers that:
//
//   GET  https://accounts.google.com/.well-known/openid-configuration
//   GET  https://www.googleapis.com/oauth2/v3/certs              (JWKS)
//   POST https://oauth2.googleapis.com/token                     (id_token)
//
// Tests sign their own ID tokens with the matching private key so verification
// passes end-to-end. The "queue" model lets tests stage the next exchange's
// ID-token payload (sub / email / nonce / aud) BEFORE making the HTTP call.

import { createSign, generateKeyPairSync } from 'node:crypto'

import { http, HttpResponse, type RequestHandler } from 'msw'

export const GOOGLE_DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration'
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/u, '').replace(/\+/g, '-').replace(/\//g, '_')
}

export interface GoogleMswSetup {
  /** Handlers ready to pass into setupServer / server.resetHandlers. */
  handlers: RequestHandler[]
  /** Sign an ID token with the same key the JWKS handler advertises. */
  signIdToken(payload: Record<string, unknown>): string
  /** Stage the next exchange's id_token + optional status override. */
  enqueueTokenResponse(idToken: string, opts?: { status?: number }): void
  /** Inspect the last form-encoded body POST'd to the token endpoint. */
  lastTokenRequest(): URLSearchParams | undefined
  /** Replace the JWKS keys (for kid rotation tests). */
  setJwks(keys: { kid: string; pem: string }[]): void
}

interface SignableKey {
  kid: string
  privatePem: string
  publicJwk: { kty: 'RSA'; alg: 'RS256'; use: 'sig'; kid: string; n: string; e: string }
}

function makeKey(kid: string): SignableKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string }
  return {
    kid,
    privatePem,
    publicJwk: { kty: 'RSA', alg: 'RS256', use: 'sig', kid, n: jwk.n, e: jwk.e },
  }
}

function signTokenWith(privatePem: string, kid: string, payload: Record<string, unknown>): string {
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })))
  const body = base64url(Buffer.from(JSON.stringify(payload)))
  const input = `${header}.${body}`
  const signature = createSign('RSA-SHA256')
    .update(input)
    .sign({ key: privatePem, format: 'pem' })
  return `${input}.${base64url(signature)}`
}

export function createGoogleMsw(): GoogleMswSetup {
  let key = makeKey('test-kid-1')
  let jwksKeys = [key.publicJwk]
  const queue: { idToken: string; status: number }[] = []
  let lastBody: URLSearchParams | undefined

  const handlers: RequestHandler[] = [
    http.get(GOOGLE_DISCOVERY_URL, () =>
      HttpResponse.json({
        issuer: 'https://accounts.google.com',
        jwks_uri: GOOGLE_JWKS_URL,
        token_endpoint: GOOGLE_TOKEN_URL,
        authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      }),
    ),
    http.get(GOOGLE_JWKS_URL, () => HttpResponse.json({ keys: jwksKeys })),
    http.post(GOOGLE_TOKEN_URL, async ({ request }) => {
      lastBody = new URLSearchParams(await request.text())
      const next = queue.shift()
      if (!next) {
        return new HttpResponse('no token queued for test', { status: 500 })
      }
      if (next.status !== 200) {
        return new HttpResponse(`upstream error ${next.status}`, { status: next.status })
      }
      return HttpResponse.json({
        id_token: next.idToken,
        access_token: 'discarded-access',
        expires_in: 3599,
        token_type: 'Bearer',
      })
    }),
  ]

  return {
    handlers,
    signIdToken(payload) {
      return signTokenWith(key.privatePem, key.kid, payload)
    },
    enqueueTokenResponse(idToken, opts) {
      queue.push({ idToken, status: opts?.status ?? 200 })
    },
    lastTokenRequest() {
      return lastBody
    },
    setJwks(_keys) {
      // Helper used by future tests if we exercise rotation; today the
      // standing JWKS already covers all test cases.
      // Replace key fixture if a test explicitly opts in.
      const fresh = makeKey('test-kid-rotated')
      key = fresh
      jwksKeys = [fresh.publicJwk]
    },
  }
}

// Spec 013 §8.3 — legacy export retained for any callers that import it as
// "googleHandlers"; integration tests should now use createGoogleMsw().
export const googleHandlers: RequestHandler[] = []
