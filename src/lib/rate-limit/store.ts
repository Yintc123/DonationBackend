// Spec 010 §6.3 — sliding window store on top of ioredis EVAL/EVALSHA.
//
// We SCRIPT LOAD the sliding-window Lua source once (cached SHA), then call
// EVALSHA on every hit. ioredis falls back to EVAL automatically on NOSCRIPT,
// so we don't need to retry manually — but we still pre-load to detect Lua
// syntax errors at startup, not at first request (spec 005 §11.2).
//
// One Redis round trip per `consume()`. The script atomically:
//   - reads the previous + current window counters
//   - computes the §2.3 estimate
//   - decides allow / deny
//   - on allow: INCRBY + PEXPIRE (windowMs * 2)
//   - returns { allowed, remaining, resetInMs }

import type { Redis } from 'ioredis'

import { rateLimitKey, windowStartMs, type RateLimitKeyArgs } from './keys.js'
import { SLIDING_WINDOW_LUA } from './script.js'

export interface ConsumeArgs {
  layer: 'global' | 'route-ip' | 'route-user' | 'purpose'
  windowMs: number
  limit: number
  cost: number
  nowMs: number
  /** L1 / L2 */
  ip?: string
  /** L2 / L3 */
  routeId?: string
  /** L3 */
  userId?: string
  /** L4 */
  purposeName?: string
  /** L4 */
  identifierHash?: string
}

export interface ConsumeResult {
  allowed: boolean
  remaining: number
  resetInMs: number
}

export interface SlidingWindowStore {
  consume(args: ConsumeArgs): Promise<ConsumeResult>
}

export interface CreateStoreOptions {
  redis: Redis
  /** Override the Lua source — used by tests that need to provoke errors. */
  luaSource?: string
}

export async function createSlidingWindowStore(
  opts: CreateStoreOptions,
): Promise<SlidingWindowStore> {
  const source = opts.luaSource ?? SLIDING_WINDOW_LUA

  // Eager SCRIPT LOAD so Lua syntax errors fail at app startup, not on the
  // first 429-eligible request. ioredis.script('LOAD', src) returns the SHA.
  const sha = (await opts.redis.script('LOAD', source)) as string

  return {
    async consume(args: ConsumeArgs): Promise<ConsumeResult> {
      const currStartMs = windowStartMs(args.nowMs, args.windowMs)
      const prevStartMs = currStartMs - args.windowMs

      const baseArgs = toKeyArgs(args)
      const prevKey = rateLimitKey({ ...baseArgs, windowStartMs: prevStartMs })
      const currKey = rateLimitKey({ ...baseArgs, windowStartMs: currStartMs })

      // ioredis returns the Lua array as JS array; numbers preserved.
      const raw = (await opts.redis.evalsha(
        sha,
        2,
        prevKey,
        currKey,
        String(args.windowMs),
        String(args.limit),
        String(args.cost),
        String(args.nowMs),
      )) as [number, number, number]

      return {
        allowed: raw[0] === 1,
        remaining: raw[1],
        resetInMs: raw[2],
      }
    },
  }
}

function toKeyArgs(args: ConsumeArgs): Omit<RateLimitKeyArgs, 'windowStartMs'> {
  switch (args.layer) {
    case 'global':
      return { layer: 'global', ip: args.ip }
    case 'route-ip':
      return { layer: 'route-ip', routeId: args.routeId, ip: args.ip }
    case 'route-user':
      return { layer: 'route-user', routeId: args.routeId, userId: args.userId }
    case 'purpose':
      return {
        layer: 'purpose',
        purposeName: args.purposeName,
        identifierHash: args.identifierHash,
      }
  }
}
