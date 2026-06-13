// Spec 007 §9 — Redis-backed OAuth session state store.
//
//   key   : jkod:auth:oauth:{sid}
//   value : Hash { state, nonce, codeVerifier, returnTo?, intent, accountId? }
//   ttl   : 600 seconds (spec §9.1)
//   semantic: one-shot (§9.1) — the caller MUST delete the key as soon as
//             it has read it on exchange.
//
// This module is a thin adapter; replay / single-use enforcement lives at
// the route layer (it knows when to call `consumeAndDelete`).

import type { Redis } from 'ioredis'

import { buildKey } from '../redis/index.js'

export const OAUTH_SESSION_TTL_SEC = 600 // Spec §9.1.

export type OAuthIntent = 'login' | 'link'

export interface OAuthSessionData {
  state: string
  nonce: string
  codeVerifier: string
  intent: OAuthIntent
  /** Set only for intent=login when a returnTo was supplied. */
  returnTo?: string
  /** Set only for intent=link — the account that initiated linking. */
  accountId?: string
}

export interface OAuthSessionStore {
  /**
   * Store a freshly minted OAuth session under `sid` with TTL 600s. The key
   * MUST be unique — caller generates a UUID.
   */
  put(sid: string, data: OAuthSessionData): Promise<void>
  /**
   * Read-then-delete: atomically returns the session and removes it from
   * Redis to enforce one-shot semantics (§9.1). Returns `null` if absent.
   */
  consumeAndDelete(sid: string): Promise<OAuthSessionData | null>
}

function sessionKey(sid: string): string {
  return buildKey('auth', ['oauth', sid])
}

function serialize(d: OAuthSessionData): Record<string, string> {
  const out: Record<string, string> = {
    state: d.state,
    nonce: d.nonce,
    codeVerifier: d.codeVerifier,
    intent: d.intent,
  }
  if (d.returnTo !== undefined) out.returnTo = d.returnTo
  if (d.accountId !== undefined) out.accountId = d.accountId
  return out
}

function deserialize(raw: Record<string, string>): OAuthSessionData | null {
  const { state, nonce, codeVerifier, intent } = raw
  if (!state || !nonce || !codeVerifier || (intent !== 'login' && intent !== 'link')) {
    return null
  }
  const out: OAuthSessionData = {
    state,
    nonce,
    codeVerifier,
    intent,
  }
  if (raw.returnTo !== undefined) out.returnTo = raw.returnTo
  if (raw.accountId !== undefined) out.accountId = raw.accountId
  return out
}

export function createOAuthSessionStore(redis: Redis): OAuthSessionStore {
  return {
    async put(sid, data) {
      const key = sessionKey(sid)
      const pipeline = redis.multi()
      pipeline.hset(key, serialize(data))
      pipeline.expire(key, OAUTH_SESSION_TTL_SEC)
      const results = await pipeline.exec()
      if (results === null) {
        throw new Error('oauth-session: Redis pipeline aborted')
      }
    },
    async consumeAndDelete(sid) {
      const key = sessionKey(sid)
      const pipeline = redis.multi()
      pipeline.hgetall(key)
      pipeline.del(key)
      const results = await pipeline.exec()
      if (results === null) {
        throw new Error('oauth-session: Redis pipeline aborted')
      }
      const [hgetallEntry] = results
      const raw = hgetallEntry?.[1] as Record<string, string> | undefined
      if (!raw || Object.keys(raw).length === 0) {
        return null
      }
      return deserialize(raw)
    },
  }
}
