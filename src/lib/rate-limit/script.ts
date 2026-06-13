// Spec 010 §2 — sliding window counter approximation.
//
// We keep TWO mirror representations of the same algorithm:
//
//   1. SLIDING_WINDOW_LUA — runs server-side in Redis (single round trip, no
//      race). The store.ts module SCRIPT LOADs this once and EVALSHAs it on
//      every hit.
//
//   2. computeEstimate / decide — TypeScript port of the same formula, used by
//      unit tests (which can't run Lua without Redis). The integration suite
//      then verifies the two agree.
//
// Formula (§2.3):
//   estimate = prev * (1 - elapsed/W) + curr
//   allowed  = estimate + cost ≤ limit
//
// Lua contract — KEYS: [prevKey, currKey] / ARGV: [windowMs, limit, cost, nowMs]
// Returns: { allowedFlag, remaining, resetInMs }

export const SLIDING_WINDOW_LUA = `
-- KEYS[1] = previous window key
-- KEYS[2] = current  window key
-- ARGV[1] = windowMs
-- ARGV[2] = limit
-- ARGV[3] = cost
-- ARGV[4] = nowMs
-- Returns: { allowed (0/1), remaining (integer floor), resetInMs (integer) }

local windowMs = tonumber(ARGV[1])
local limit    = tonumber(ARGV[2])
local cost     = tonumber(ARGV[3])
local nowMs    = tonumber(ARGV[4])

local elapsed  = nowMs % windowMs
local prev     = tonumber(redis.call('GET', KEYS[1]) or '0')
local curr     = tonumber(redis.call('GET', KEYS[2]) or '0')

local estimate = prev * (1 - elapsed / windowMs) + curr
local resetMs  = windowMs - elapsed

if estimate + cost > limit then
  local remaining = math.floor(limit - estimate)
  if remaining < 0 then remaining = 0 end
  return { 0, remaining, resetMs }
end

redis.call('INCRBY', KEYS[2], cost)
-- PEXPIRE covers the NEXT window so we can still read this bucket as "prev"
-- once a new window starts. Spec §2.4.
redis.call('PEXPIRE', KEYS[2], windowMs * 2)

local remaining = math.floor(limit - estimate - cost)
if remaining < 0 then remaining = 0 end
return { 1, remaining, resetMs }
`.trim()

export interface EstimateInput {
  prev: number
  curr: number
  elapsedMs: number
  windowMs: number
}

export function computeEstimate(input: EstimateInput): number {
  const decay = 1 - input.elapsedMs / input.windowMs
  return input.prev * decay + input.curr
}

export interface DecideInput extends EstimateInput {
  limit: number
  cost: number
}

export interface DecideOutput {
  allowed: boolean
  /** Non-negative integer floor — matches Lua return shape. */
  remaining: number
  resetInMs: number
}

export function decide(input: DecideInput): DecideOutput {
  const estimate = computeEstimate(input)
  const resetInMs = input.windowMs - input.elapsedMs
  if (estimate + input.cost > input.limit) {
    return {
      allowed: false,
      remaining: Math.max(0, Math.floor(input.limit - estimate)),
      resetInMs,
    }
  }
  return {
    allowed: true,
    remaining: Math.max(0, Math.floor(input.limit - estimate - input.cost)),
    resetInMs,
  }
}
