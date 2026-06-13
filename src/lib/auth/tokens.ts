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

import { createDecoder, createSigner } from 'fast-jwt'
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
  }
}
