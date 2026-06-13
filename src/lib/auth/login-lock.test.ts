// Spec 008 §5.3 — login failure counter (per-email lock).
//
// We test the pure counter math (predicate + threshold), not Redis itself.
// Integration tests exercise the Redis-backed path end-to-end.

import { describe, expect, it } from 'vitest'

import { isLocked, type LoginLockOpts } from './login-lock.js'

const OPTS: LoginLockOpts = {
  threshold: 3,
  windowSec: 900,
}

describe('isLocked (spec 008 §5.3 — per-email failure threshold)', () => {
  it('returns false when the failure count is below the threshold', () => {
    expect(isLocked(0, OPTS)).toBe(false)
    expect(isLocked(2, OPTS)).toBe(false)
  })

  it('returns true once the count reaches the threshold', () => {
    expect(isLocked(3, OPTS)).toBe(true)
    expect(isLocked(10, OPTS)).toBe(true)
  })

  it('treats missing / negative counts as zero', () => {
    expect(isLocked(-1, OPTS)).toBe(false)
  })
})
