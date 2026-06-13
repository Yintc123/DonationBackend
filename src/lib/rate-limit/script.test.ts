// Spec 010 §2 — sliding window counter approximation.
//
// The Lua script (lua/sliding-window.ts) runs server-side and is verified by
// the integration suite (real Redis). Here we test the *formula* in
// TypeScript so the math is debuggable without Redis. The Lua script must
// implement the same formula (we test that property in integration).

import { describe, expect, it } from 'vitest'

import {
  SLIDING_WINDOW_LUA,
  computeEstimate,
  decide,
} from './script.js'

describe('SLIDING_WINDOW_LUA', () => {
  it('is a non-empty Lua source string', () => {
    expect(typeof SLIDING_WINDOW_LUA).toBe('string')
    expect(SLIDING_WINDOW_LUA.length).toBeGreaterThan(0)
    // Sanity: must reference the four ARGV slots and KEYS slots used by store.ts.
    expect(SLIDING_WINDOW_LUA).toMatch(/ARGV\[1\]/)
    expect(SLIDING_WINDOW_LUA).toMatch(/ARGV\[2\]/)
    expect(SLIDING_WINDOW_LUA).toMatch(/ARGV\[3\]/)
    expect(SLIDING_WINDOW_LUA).toMatch(/ARGV\[4\]/)
    expect(SLIDING_WINDOW_LUA).toMatch(/KEYS\[1\]/)
    expect(SLIDING_WINDOW_LUA).toMatch(/KEYS\[2\]/)
    // Must increment + set a 2× window TTL (§2.4).
    expect(SLIDING_WINDOW_LUA).toMatch(/INCRBY/)
    expect(SLIDING_WINDOW_LUA).toMatch(/PEXPIRE/)
  })
})

describe('computeEstimate (spec §2.3)', () => {
  it('is currentWindowCount when prev=0', () => {
    expect(computeEstimate({ prev: 0, curr: 5, elapsedMs: 30_000, windowMs: 60_000 })).toBe(5)
  })

  it('weights previousWindowCount by (1 - elapsed/window)', () => {
    // prev=10, halfway through window → prev contributes 10 * 0.5 = 5
    expect(computeEstimate({ prev: 10, curr: 0, elapsedMs: 30_000, windowMs: 60_000 })).toBe(5)
  })

  it('combines prev decay + curr', () => {
    expect(computeEstimate({ prev: 20, curr: 7, elapsedMs: 15_000, windowMs: 60_000 })).toBe(
      20 * 0.75 + 7,
    )
  })

  it('returns currentWindowCount at the very start of a new window (elapsed=0)', () => {
    expect(computeEstimate({ prev: 100, curr: 0, elapsedMs: 0, windowMs: 60_000 })).toBe(100)
  })
})

describe('decide (spec §2.3, §3.1)', () => {
  it('allows when estimate + cost <= limit', () => {
    const out = decide({ prev: 0, curr: 5, elapsedMs: 0, windowMs: 60_000, limit: 10, cost: 1 })
    expect(out.allowed).toBe(true)
    expect(out.remaining).toBe(4)
  })

  it('denies when estimate + cost > limit', () => {
    const out = decide({ prev: 0, curr: 10, elapsedMs: 0, windowMs: 60_000, limit: 10, cost: 1 })
    expect(out.allowed).toBe(false)
    expect(out.remaining).toBe(0)
  })

  it('boundary: cost === limit at empty state is allowed', () => {
    const out = decide({ prev: 0, curr: 0, elapsedMs: 0, windowMs: 60_000, limit: 5, cost: 5 })
    expect(out.allowed).toBe(true)
    expect(out.remaining).toBe(0)
  })

  it('boundary: cost === limit+1 at empty state is denied', () => {
    const out = decide({ prev: 0, curr: 0, elapsedMs: 0, windowMs: 60_000, limit: 5, cost: 6 })
    expect(out.allowed).toBe(false)
  })

  it('never reports a negative remaining', () => {
    const out = decide({ prev: 100, curr: 100, elapsedMs: 0, windowMs: 60_000, limit: 10, cost: 1 })
    expect(out.remaining).toBe(0)
  })

  it('reset time is windowMs - elapsedMs', () => {
    const out = decide({ prev: 0, curr: 1, elapsedMs: 20_000, windowMs: 60_000, limit: 100, cost: 1 })
    expect(out.resetInMs).toBe(40_000)
  })
})
