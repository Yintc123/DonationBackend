// Spec 007 §8 — Google ID Token verifier.
//
// Pure function: takes (token, options { jwks, audience, nonce, nowSec }) and
// either resolves to the claims we care about or throws. The route layer maps
// thrown errors to AUTH_ID_TOKEN_INVALID / AUTH_EMAIL_UNVERIFIED.
//
// We intentionally do NOT bind to `jose`'s `createRemoteJWKSet` here because
// (a) jose is not installed in this repo, (b) the spec's discovery / JWKS
// caching lives in ./discovery.ts so the verifier stays unit-testable
// without network. The verifier instead receives the JWKS keys as input.
//
// Algorithm: RS256 only (Google uses RS256 for ID tokens — never the
// asymmetric ES* / EdDSA variants, never HS*).

import { createPublicKey } from 'node:crypto'

import { createDecoder, createVerifier } from 'fast-jwt'

import { timingSafeEqualStr } from './pkce.js'

const ACCEPTED_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])

export interface GoogleJwk {
  kty: 'RSA'
  use?: string
  alg?: string
  kid: string
  n: string
  e: string
}

export interface GoogleJwkSet {
  keys: GoogleJwk[]
}

export interface GoogleVerifyOptions {
  audience: string
  /** The nonce we stored in Redis (`jkod:auth:oauth:{sid}`). */
  nonce: string
  jwks: GoogleJwkSet
  /** Override "now" in seconds — tests use this for deterministic exp checks. */
  nowSec?: number
  /** Spec §8.1 — ±60s by default. */
  clockSkewSec?: number
}

export interface VerifiedGoogleIdToken {
  sub: string
  email: string
  emailVerified: boolean
  /** All raw claims, in case the caller needs picture / name / etc. */
  raw: Record<string, unknown>
}

const decoder = createDecoder({ complete: true })

interface DecodedHeader {
  alg?: string
  kid?: string
  typ?: string
}

interface DecodedComplete {
  header: DecodedHeader
  payload: Record<string, unknown>
  signature: string
  input: string
}

function jwkToPublicKey(jwk: GoogleJwk): string {
  return createPublicKey({ key: jwk as unknown as Record<string, string>, format: 'jwk' })
    .export({ type: 'spki', format: 'pem' })
    .toString()
}

export async function verifyGoogleIdToken(
  token: string,
  options: GoogleVerifyOptions,
): Promise<VerifiedGoogleIdToken> {
  let decoded: DecodedComplete
  try {
    decoded = decoder(token) as DecodedComplete
  } catch (err) {
    throw new IdTokenError('id token is malformed', err)
  }

  const alg = decoded.header.alg
  if (alg !== 'RS256') {
    throw new IdTokenError(`id token uses unsupported algorithm "${alg}"`)
  }
  const kid = decoded.header.kid
  if (typeof kid !== 'string' || kid.length === 0) {
    throw new IdTokenError('id token header is missing kid')
  }

  const jwk = options.jwks.keys.find((k) => k.kid === kid)
  if (!jwk) {
    throw new IdTokenError(`id token kid "${kid}" not found in JWKS`)
  }

  let publicPem: string
  try {
    publicPem = jwkToPublicKey(jwk)
  } catch (err) {
    throw new IdTokenError('failed to import JWK as public key', err)
  }

  const verifier = createVerifier({
    key: publicPem,
    algorithms: ['RS256'],
    clockTolerance: (options.clockSkewSec ?? 60) * 1000,
    ...(options.nowSec !== undefined ? { clockTimestamp: options.nowSec * 1000 } : {}),
  })

  let claims: Record<string, unknown>
  try {
    claims = (await verifier(token)) as Record<string, unknown>
  } catch (err) {
    throw new IdTokenError('id token signature or expiry check failed', err)
  }

  // Spec §8.1 — additional checks fast-jwt does not perform.
  const iss = claims.iss
  if (typeof iss !== 'string' || !ACCEPTED_ISSUERS.has(iss)) {
    throw new IdTokenError(`id token iss "${String(iss)}" is not a Google issuer`)
  }
  const aud = claims.aud
  if (typeof aud !== 'string' || !timingSafeEqualStr(aud, options.audience)) {
    throw new IdTokenError('id token aud does not match GOOGLE_CLIENT_ID')
  }
  const nonce = claims.nonce
  if (typeof nonce !== 'string' || !timingSafeEqualStr(nonce, options.nonce)) {
    throw new IdTokenError('id token nonce does not match the stored nonce')
  }
  const sub = claims.sub
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new IdTokenError('id token is missing sub')
  }
  const email = claims.email
  if (typeof email !== 'string' || email.length === 0) {
    throw new IdTokenError('id token is missing email')
  }
  const emailVerified = claims.email_verified
  if (emailVerified !== true) {
    throw new IdTokenError('id token email_verified is not true')
  }

  return {
    sub,
    email,
    emailVerified: true,
    raw: claims,
  }
}

export class IdTokenError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined)
    this.name = 'IdTokenError'
  }
}
