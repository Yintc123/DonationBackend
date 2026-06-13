// Spec 007 §8 — ID Token verification (signature + iss + aud + exp + nonce
// + email_verified). Pure module: takes the raw JWKS as input so we don't
// touch the network in unit tests.

import { generateKeyPairSync, createSign } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { verifyGoogleIdToken, type GoogleVerifyOptions } from './id-token.js'

// ── Fixture: deterministic RSA key + JWKS we can sign tokens against ─────

interface KeyFixture {
  kid: string
  privatePem: string
  jwk: {
    kty: 'RSA'
    use: 'sig'
    alg: 'RS256'
    kid: string
    n: string
    e: string
  }
}

function makeKeyFixture(kid: string): KeyFixture {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string }
  return {
    kid,
    privatePem,
    jwk: {
      kty: 'RSA',
      use: 'sig',
      alg: 'RS256',
      kid,
      n: jwk.n,
      e: jwk.e,
    },
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/u, '').replace(/\+/g, '-').replace(/\//g, '_')
}

interface SignArgs {
  kid: string
  privatePem: string
  payload: Record<string, unknown>
}

function signRs256(args: SignArgs): string {
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: args.kid })))
  const body = base64url(Buffer.from(JSON.stringify(args.payload)))
  const signingInput = `${header}.${body}`
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign({ key: args.privatePem, format: 'pem' })
  return `${signingInput}.${base64url(signature)}`
}

const NOW = 1_700_000_000
const ONE_HOUR = 60 * 60

const CLIENT_ID = 'test-google-client-id'
const NONCE = 'nonce-from-redis'

function defaultPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: 'google-sub-12345',
    email: 'user@example.com',
    email_verified: true,
    nonce: NONCE,
    iat: NOW - 5,
    exp: NOW + ONE_HOUR,
    ...overrides,
  }
}

function defaultOptions(jwks: KeyFixture['jwk'][]): GoogleVerifyOptions {
  return {
    audience: CLIENT_ID,
    nonce: NONCE,
    jwks: { keys: jwks },
    nowSec: NOW,
    clockSkewSec: 60,
  }
}

describe('verifyGoogleIdToken (spec 007 §8)', () => {
  it('should return the claims when the token is well-signed and all checks pass', async () => {
    const fixture = makeKeyFixture('key-1')
    const token = signRs256({
      kid: fixture.kid,
      privatePem: fixture.privatePem,
      payload: defaultPayload(),
    })
    const claims = await verifyGoogleIdToken(token, defaultOptions([fixture.jwk]))
    expect(claims.sub).toBe('google-sub-12345')
    expect(claims.email).toBe('user@example.com')
    expect(claims.emailVerified).toBe(true)
  })

  it('should reject when the signature does not match the JWKS public key', async () => {
    const fixture = makeKeyFixture('key-1')
    const otherFixture = makeKeyFixture('key-1') // same kid, different key
    const token = signRs256({
      kid: fixture.kid,
      privatePem: fixture.privatePem,
      payload: defaultPayload(),
    })
    // Verifier sees ONLY otherFixture's JWK → signature mismatch.
    await expect(
      verifyGoogleIdToken(token, defaultOptions([otherFixture.jwk])),
    ).rejects.toThrow(/signature|invalid/i)
  })

  it('should reject when the iss claim is not a Google issuer', async () => {
    const fixture = makeKeyFixture('key-1')
    const token = signRs256({
      kid: fixture.kid,
      privatePem: fixture.privatePem,
      payload: defaultPayload({ iss: 'https://evil.example.com' }),
    })
    await expect(
      verifyGoogleIdToken(token, defaultOptions([fixture.jwk])),
    ).rejects.toThrow(/iss|issuer/i)
  })

  it('should accept both Google iss values (https + bare)', async () => {
    const fixture = makeKeyFixture('key-1')
    const opts = defaultOptions([fixture.jwk])

    const tokenHttps = signRs256({
      kid: fixture.kid,
      privatePem: fixture.privatePem,
      payload: defaultPayload({ iss: 'https://accounts.google.com' }),
    })
    const tokenBare = signRs256({
      kid: fixture.kid,
      privatePem: fixture.privatePem,
      payload: defaultPayload({ iss: 'accounts.google.com' }),
    })
    await expect(verifyGoogleIdToken(tokenHttps, opts)).resolves.toBeDefined()
    await expect(verifyGoogleIdToken(tokenBare, opts)).resolves.toBeDefined()
  })

  it('should reject when the aud claim does not equal GOOGLE_CLIENT_ID', async () => {
    const fixture = makeKeyFixture('key-1')
    const token = signRs256({
      kid: fixture.kid,
      privatePem: fixture.privatePem,
      payload: defaultPayload({ aud: 'some-other-client' }),
    })
    await expect(
      verifyGoogleIdToken(token, defaultOptions([fixture.jwk])),
    ).rejects.toThrow(/aud|audience/i)
  })

  it('should reject when exp is in the past beyond the clock skew', async () => {
    const fixture = makeKeyFixture('key-1')
    const token = signRs256({
      kid: fixture.kid,
      privatePem: fixture.privatePem,
      payload: defaultPayload({ exp: NOW - 3600, iat: NOW - 3601 }),
    })
    await expect(
      verifyGoogleIdToken(token, defaultOptions([fixture.jwk])),
    ).rejects.toThrow(/exp|expired/i)
  })

  it('should reject when the nonce claim does not match the stored nonce', async () => {
    const fixture = makeKeyFixture('key-1')
    const token = signRs256({
      kid: fixture.kid,
      privatePem: fixture.privatePem,
      payload: defaultPayload({ nonce: 'attacker-nonce' }),
    })
    await expect(
      verifyGoogleIdToken(token, defaultOptions([fixture.jwk])),
    ).rejects.toThrow(/nonce/i)
  })

  it('should reject when email_verified is false (spec §13.5)', async () => {
    const fixture = makeKeyFixture('key-1')
    const token = signRs256({
      kid: fixture.kid,
      privatePem: fixture.privatePem,
      payload: defaultPayload({ email_verified: false }),
    })
    await expect(
      verifyGoogleIdToken(token, defaultOptions([fixture.jwk])),
    ).rejects.toThrow(/email/i)
  })

  it('should reject when the token header kid is missing from the JWKS', async () => {
    const fixture = makeKeyFixture('key-1')
    const otherFixture = makeKeyFixture('key-2')
    const token = signRs256({
      kid: fixture.kid,
      privatePem: fixture.privatePem,
      payload: defaultPayload(),
    })
    await expect(
      verifyGoogleIdToken(token, defaultOptions([otherFixture.jwk])),
    ).rejects.toThrow(/kid|key/i)
  })
})
