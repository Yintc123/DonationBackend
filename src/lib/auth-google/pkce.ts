// Spec 007 §9 — pure helpers for OAuth / OIDC state, nonce, PKCE values.
//
// All randomness goes through node:crypto. We expose:
//   - generateState        (§9.2 32 bytes base64url)
//   - generateNonce        (§9.2 32 bytes base64url)
//   - generateCodeVerifier (§9.2 64 bytes base64url)
//   - computeCodeChallenge (§9.2 BASE64URL(SHA256(verifier)) — RFC 7636 S256)
//   - base64UrlEncode      (RFC 4648 §5 url-safe alphabet, no padding)
//   - timingSafeEqualStr   (§9.3 length-tolerant timing-safe compare)
//
// Kept side-effect free so it can be re-used by unit / integration tests
// (e.g. integration tests need to recreate a `code_challenge` they can match).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/u, '').replace(/\+/g, '-').replace(/\//g, '_')
}

export function generateState(): string {
  return base64UrlEncode(randomBytes(32))
}

export function generateNonce(): string {
  return base64UrlEncode(randomBytes(32))
}

export function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(64))
}

export function computeCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest())
}

/**
 * Constant-time string comparison. Returns false (without throwing) when the
 * inputs differ in length, so callers do not need to length-guard externally.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8')
  const bBuf = Buffer.from(b, 'utf8')
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}
