// Spec 007 §11 (referenced by spec 008) — JWT issuance + Redis refresh store.
//
// Token strategy (ADR 004 + spec 007 §11):
//   - Access: HS256 with JWT_ACCESS_SECRET, 3h, claims { sub, type, iss, aud,
//     jti, iat, exp }.
//   - Refresh: HS256 with JWT_REFRESH_SECRET, 30d, claims { sub, type='refresh',
//     iss, jti, iat, exp }.
//   - Each refresh `jti` is recorded in Redis at
//       jkod:auth:refresh:{tokenId}  Hash { accountId, hashedToken, createdAt, used }
//     with TTL = refreshTtlSec + 60s grace. Replay detection in spec 007
//     §5 / §11.3 fires when a token already marked `used=true` is presented
//     again — it revokes ALL the user's refresh tokens. Spec 008 only needs
//     the issuance + store path; the rotate / replay flow ships with spec 007.
//
// We use `fast-jwt` directly (it is the engine behind `@fastify/jwt`) so this
// module stays usable from both the request lifecycle (route handlers) and
// background contexts (e.g. password-change → revoke-all).

import { createHash, randomUUID } from 'node:crypto'

import { createDecoder, createSigner, createVerifier } from 'fast-jwt'
import type { Redis } from 'ioredis'

import { buildKey } from '../redis/index.js'

export interface TokenSecrets {
  accessSecret: string
  refreshSecret: string
  issuer: string
  audience: string
  accessTtlSec: number
  refreshTtlSec: number
}

export interface IssuedToken {
  token: string
  tokenId: string
  expiresIn: number
}

interface BaseClaims {
  sub: string
  type: 'access' | 'refresh'
  iss: string
  aud?: string
}

const decoder = createDecoder()

export interface DecodedClaims {
  sub?: string
  type?: string
  iss?: string
  aud?: string
  jti?: string
  iat?: number
  exp?: number
  [k: string]: unknown
}

/** Decode a JWT without verifying the signature (test / introspection only). */
export function decodeJwtUnsafe(token: string): DecodedClaims {
  return decoder(token) as DecodedClaims
}

export async function signAccessToken(
  accountId: string,
  secrets: TokenSecrets,
): Promise<IssuedToken> {
  const jti = randomUUID()
  const signer = createSigner({
    algorithm: 'HS256',
    key: secrets.accessSecret,
    iss: secrets.issuer,
    aud: secrets.audience,
    jti,
    expiresIn: secrets.accessTtlSec * 1000,
  })
  const payload: BaseClaims = { sub: accountId, type: 'access', iss: secrets.issuer }
  const token = signer(payload) as string
  return { token, tokenId: jti, expiresIn: secrets.accessTtlSec }
}

export async function signRefreshToken(
  accountId: string,
  secrets: TokenSecrets,
): Promise<IssuedToken> {
  const jti = randomUUID()
  const signer = createSigner({
    algorithm: 'HS256',
    key: secrets.refreshSecret,
    iss: secrets.issuer,
    jti,
    expiresIn: secrets.refreshTtlSec * 1000,
  })
  const payload: BaseClaims = { sub: accountId, type: 'refresh', iss: secrets.issuer }
  const token = signer(payload) as string
  return { token, tokenId: jti, expiresIn: secrets.refreshTtlSec }
}

// ── Verification (spec 007 §5.1 / §11) ──────────────────────────────────────

export interface VerifiedAccessClaims extends DecodedClaims {
  sub: string
  type: 'access'
  jti: string
}

export interface VerifiedRefreshClaims extends DecodedClaims {
  sub: string
  type: 'refresh'
  jti: string
}

export async function verifyAccessToken(
  token: string,
  secrets: TokenSecrets,
): Promise<VerifiedAccessClaims> {
  const verifier = createVerifier({
    key: secrets.accessSecret,
    algorithms: ['HS256'],
    allowedIss: secrets.issuer,
  })
  const claims = (await verifier(token)) as DecodedClaims
  if (claims.type !== 'access') {
    throw new Error('tokens: expected type=access in JWT')
  }
  if (typeof claims.sub !== 'string' || typeof claims.jti !== 'string') {
    throw new Error('tokens: access token is missing sub/jti')
  }
  return claims as VerifiedAccessClaims
}

export async function verifyRefreshToken(
  token: string,
  secrets: TokenSecrets,
): Promise<VerifiedRefreshClaims> {
  const verifier = createVerifier({
    key: secrets.refreshSecret,
    algorithms: ['HS256'],
    allowedIss: secrets.issuer,
  })
  const claims = (await verifier(token)) as DecodedClaims
  if (claims.type !== 'refresh') {
    throw new Error('tokens: expected type=refresh in JWT')
  }
  if (typeof claims.sub !== 'string' || typeof claims.jti !== 'string') {
    throw new Error('tokens: refresh token is missing sub/jti')
  }
  return claims as VerifiedRefreshClaims
}

// ── Redis refresh store ─────────────────────────────────────────────────────

const REFRESH_GRACE_SEC = 60 // Spec 007 §11.3.

function refreshKey(tokenId: string): string {
  return buildKey('auth', ['refresh', tokenId])
}

function userRefreshSetKey(accountId: string): string {
  return buildKey('auth', ['refresh', 'user', accountId])
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export type RefreshConsumeOutcome =
  | { result: 'ok'; accountId: string }
  | { result: 'not-found' }
  | { result: 'replay'; accountId: string }

export interface RefreshStore {
  /** Persist a freshly minted refresh token. */
  store(args: {
    accountId: string
    tokenId: string
    token: string
    refreshTtlSec: number
  }): Promise<void>
  /** Spec 007 §6.2 / spec 008 §6.1 — revoke every refresh for the account. */
  revokeAll(accountId: string): Promise<number>
  /**
   * Spec 007 §5.1 — consume a refresh token as part of rotation.
   *
   * Behaviour:
   *   - record not found        → `{ result: 'not-found' }` (AUTH_REFRESH_REVOKED)
   *   - record present, used    → `{ result: 'replay', accountId }`
   *     (caller MUST revoke ALL refresh tokens for accountId per §11.4)
   *   - record present, unused, hash mismatch → `{ result: 'not-found' }`
   *     (treat as "the supplied JWT is not the one we issued" — same
   *     observable behaviour as revoked)
   *   - record present, unused, hash matches  → mark used=true → `{ result: 'ok', accountId }`
   */
  consume(tokenId: string, token: string): Promise<RefreshConsumeOutcome>
  /** Spec 007 §6.1 — single-session logout: delete one refresh + SREM. */
  revokeOne(tokenId: string): Promise<boolean>
}

export function createRefreshStore(redis: Redis): RefreshStore {
  return {
    async store({ accountId, tokenId, token, refreshTtlSec }) {
      const key = refreshKey(tokenId)
      const setKey = userRefreshSetKey(accountId)
      const ttl = refreshTtlSec + REFRESH_GRACE_SEC
      const pipeline = redis.multi()
      pipeline.hset(key, {
        accountId,
        hashedToken: hashToken(token),
        createdAt: String(Date.now()),
        used: 'false',
      })
      pipeline.expire(key, ttl)
      pipeline.sadd(setKey, tokenId)
      pipeline.expire(setKey, ttl)
      const results = await pipeline.exec()
      if (results === null) {
        throw new Error('tokens: refresh store pipeline aborted')
      }
    },
    async revokeAll(accountId: string): Promise<number> {
      const setKey = userRefreshSetKey(accountId)
      const tokenIds = await redis.smembers(setKey)
      if (tokenIds.length === 0) return 0
      const pipeline = redis.multi()
      for (const id of tokenIds) {
        pipeline.del(refreshKey(id))
      }
      pipeline.del(setKey)
      await pipeline.exec()
      return tokenIds.length
    },
    async consume(tokenId, token) {
      const key = refreshKey(tokenId)
      const data = await redis.hgetall(key)
      if (!data || Object.keys(data).length === 0) {
        return { result: 'not-found' }
      }
      const accountId = data.accountId
      const expectedHash = data.hashedToken
      const used = data.used === 'true'
      if (typeof accountId !== 'string') {
        return { result: 'not-found' }
      }
      if (used) {
        return { result: 'replay', accountId }
      }
      if (typeof expectedHash !== 'string' || hashToken(token) !== expectedHash) {
        // Same observable as "not-found" — do not leak whether the record
        // simply does not exist or carries a different hash.
        return { result: 'not-found' }
      }
      // Mark used=true preserving the current TTL.
      const ttl = await redis.ttl(key)
      const pipeline = redis.multi()
      pipeline.hset(key, { used: 'true' })
      if (ttl > 0) pipeline.expire(key, ttl)
      const results = await pipeline.exec()
      if (results === null) {
        throw new Error('tokens: refresh consume pipeline aborted')
      }
      return { result: 'ok', accountId }
    },
    async revokeOne(tokenId) {
      const key = refreshKey(tokenId)
      const data = await redis.hgetall(key)
      if (!data || Object.keys(data).length === 0) {
        return false
      }
      const accountId = data.accountId
      const pipeline = redis.multi()
      pipeline.del(key)
      if (typeof accountId === 'string') {
        pipeline.srem(userRefreshSetKey(accountId), tokenId)
      }
      await pipeline.exec()
      return true
    },
  }
}
