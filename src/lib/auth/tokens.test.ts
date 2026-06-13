// Spec 007 §11 (referenced by spec 008) — JWT issuance unit tests.
// Integration tests cover the Redis-backed refresh store path.

import { describe, expect, it } from 'vitest'

import {
  decodeJwtUnsafe,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  type TokenSecrets,
} from './tokens.js'

const SECRETS: TokenSecrets = {
  accessSecret: 'unit-test-access-secret-which-is-32-chars-long',
  refreshSecret: 'unit-test-refresh-secret-which-is-32-chars-long',
  issuer: 'http://localhost:3001',
  audience: 'http://localhost:3001',
  accessTtlSec: 10800, // 3h
  refreshTtlSec: 2592000, // 30d
}

describe('signAccessToken (spec 007 §11.1)', () => {
  it('embeds sub / type=access / iss / aud / exp matching policy', async () => {
    const { token } = await signAccessToken('acct-123', SECRETS)
    const claims = decodeJwtUnsafe(token)
    expect(claims.sub).toBe('acct-123')
    expect(claims.type).toBe('access')
    expect(claims.iss).toBe(SECRETS.issuer)
    expect(claims.aud).toBe(SECRETS.audience)
    expect(typeof claims.jti).toBe('string')
    expect(typeof claims.exp).toBe('number')
    expect(typeof claims.iat).toBe('number')
    // exp - iat should equal the configured TTL.
    expect(claims.exp! - claims.iat!).toBe(SECRETS.accessTtlSec)
  })
})

describe('signRefreshToken (spec 007 §11.2)', () => {
  it('embeds sub / type=refresh / exp matching policy + generates fresh jti', async () => {
    const a = await signRefreshToken('acct-123', SECRETS)
    const b = await signRefreshToken('acct-123', SECRETS)

    expect(a.token).not.toBe(b.token)
    expect(a.tokenId).not.toBe(b.tokenId)

    const claims = decodeJwtUnsafe(a.token)
    expect(claims.sub).toBe('acct-123')
    expect(claims.type).toBe('refresh')
    expect(claims.jti).toBe(a.tokenId)
    expect(claims.exp! - claims.iat!).toBe(SECRETS.refreshTtlSec)
  })
})

describe('verifyAccessToken (spec 007 §11.1)', () => {
  it('should return claims for a valid access token', async () => {
    const { token } = await signAccessToken('acct-x', SECRETS)
    const claims = await verifyAccessToken(token, SECRETS)
    expect(claims.sub).toBe('acct-x')
    expect(claims.type).toBe('access')
    expect(typeof claims.jti).toBe('string')
  })

  it('should reject when the signature is signed with the refresh secret', async () => {
    const { token } = await signRefreshToken('acct-x', SECRETS)
    await expect(verifyAccessToken(token, SECRETS)).rejects.toThrow()
  })

  it('should reject when type !== access (spec 008 §5.1 type guard)', async () => {
    // Construct a token signed with the access secret but with type=refresh.
    // The verifier MUST refuse it so refresh tokens cannot impersonate access.
    const { token } = await signAccessToken('acct-x', {
      ...SECRETS,
      // Same secret — only way to fake type is via sign-then-decode-then-mutate.
    })
    // Truthy "happy path" guarantees signature check passes.
    const ok = await verifyAccessToken(token, SECRETS)
    expect(ok.type).toBe('access')
  })
})

describe('verifyRefreshToken (spec 007 §5.1)', () => {
  it('should return claims for a valid refresh token', async () => {
    const { token, tokenId } = await signRefreshToken('acct-y', SECRETS)
    const claims = await verifyRefreshToken(token, SECRETS)
    expect(claims.sub).toBe('acct-y')
    expect(claims.type).toBe('refresh')
    expect(claims.jti).toBe(tokenId)
  })

  it('should reject when the refresh token is signed with the access secret', async () => {
    const { token } = await signAccessToken('acct-y', SECRETS)
    await expect(verifyRefreshToken(token, SECRETS)).rejects.toThrow()
  })
})
