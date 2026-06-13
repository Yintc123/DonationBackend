// Spec 007 §11 (referenced by spec 008) — JWT issuance unit tests.
// Integration tests cover the Redis-backed refresh store path.

import { describe, expect, it } from 'vitest'

import { decodeJwtUnsafe, signAccessToken, signRefreshToken, type TokenSecrets } from './tokens.js'

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
