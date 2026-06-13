// Spec 008 §5.3 — Redis-backed per-email login failure counter / lock.
//
// We use a thin INCR-with-EXPIRE counter under
//   jkod:auth:login_lock:<sha256(email).slice(0,16)>
// The first INCR pipes a PEXPIRE so the key auto-evicts after the window.
// The email is hashed (spec §5.3) so PII does not land in Redis.
//
// Lock semantics (spec §5.3):
//   - count >= threshold  → next attempt is rejected with AUTH_ACCOUNT_LOCKED
//   - count < threshold   → caller proceeds; on failure, `recordFailure()`
//   - on success           → `reset()` clears the counter
//
// The pure helper `isLocked()` lets us unit-test the threshold math without
// Redis; the Redis IO is exercised end-to-end by the integration suite.

import { createHash } from 'node:crypto'

import type { Redis } from 'ioredis'

import { buildKey } from '../redis/index.js'

export interface LoginLockOpts {
  /** Failures within the window required to lock the account. */
  threshold: number
  /** Window length in seconds. */
  windowSec: number
}

export function isLocked(count: number, opts: LoginLockOpts): boolean {
  if (count < 0) return false
  return count >= opts.threshold
}

/** Spec §5.3 — hash email so PII never lands in Redis dumps. */
export function emailKeyHash(email: string): string {
  return createHash('sha256').update(email).digest('hex').slice(0, 16)
}

function lockKey(email: string): string {
  return buildKey('auth', ['login_lock', emailKeyHash(email)])
}

export interface LoginLockClient {
  /** Returns the current failure count (0 if absent). */
  getCount(email: string): Promise<number>
  /** Atomically increments the counter and (re)sets the TTL on the first hit. */
  recordFailure(email: string): Promise<number>
  /** Spec §5.1 — clear the counter after a successful login. */
  reset(email: string): Promise<void>
}

export function createLoginLockClient(redis: Redis, opts: LoginLockOpts): LoginLockClient {
  return {
    async getCount(email: string): Promise<number> {
      const raw = await redis.get(lockKey(email))
      return raw === null ? 0 : Number(raw)
    },
    async recordFailure(email: string): Promise<number> {
      const key = lockKey(email)
      // INCR returns the new value; pair with PEXPIRE so the first hit seeds
      // the TTL. We use a pipeline (not Lua) because it's a 2-cmd operation
      // and atomicity across the pair is not required for correctness here:
      // worst case the TTL is reset on every failure, which is what §5.3 wants
      // (sliding window).
      const pipeline = redis.multi()
      pipeline.incr(key)
      pipeline.expire(key, opts.windowSec)
      const results = await pipeline.exec()
      // multi.exec() returns null if the transaction was aborted; treat as
      // failure-closed (caller will retry).
      if (results === null) {
        throw new Error('login-lock: Redis pipeline aborted')
      }
      const incrEntry = results[0]
      if (!incrEntry || incrEntry[0] !== null) {
        throw new Error('login-lock: INCR failed', { cause: incrEntry?.[0] ?? undefined })
      }
      return Number(incrEntry[1])
    },
    async reset(email: string): Promise<void> {
      await redis.del(lockKey(email))
    },
  }
}
