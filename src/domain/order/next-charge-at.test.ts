// Spec 021 §7.7 — computeNextChargeAt(now, billingDay) purity contract.
//
// The spec table fixes four boundary cases we MUST cover:
//
// | now (UTC date) | billingDay | nextChargeAt              |
// |----------------|------------|---------------------------|
// | 2026-06-15     | DAY_16     | 2026-06-16 00:00:00 UTC   |
// | 2026-06-16     | DAY_16     | 2026-07-16 00:00:00 UTC   | "當天視為已過"
// | 2026-06-20     | DAY_16     | 2026-07-16 00:00:00 UTC   |
// | 2026-06-30     | DAY_6      | 2026-07-06 00:00:00 UTC   |
//
// The "same day = already past" rule (strict `<`) is the load-bearing
// invariant — bill on the 16th and you call computeNextChargeAt _on_ the
// 16th, the cron has already missed today's window so the next eligible
// run is next month.

import { describe, expect, it } from 'vitest'

import { computeNextChargeAt } from './next-charge-at.js'

describe('computeNextChargeAt(now, billingDay) — spec 021 §7.7', () => {
  it('returns 2026-06-16 00:00:00Z for now=2026-06-15, billingDay=DAY_16', () => {
    const now = new Date('2026-06-15T08:00:00.000Z')
    expect(computeNextChargeAt(now, 'DAY_16').toISOString()).toBe('2026-06-16T00:00:00.000Z')
  })

  it('returns 2026-07-16 00:00:00Z for now=2026-06-16, billingDay=DAY_16 (same-day is already-past)', () => {
    const now = new Date('2026-06-16T08:00:00.000Z')
    expect(computeNextChargeAt(now, 'DAY_16').toISOString()).toBe('2026-07-16T00:00:00.000Z')
  })

  it('returns 2026-07-16 00:00:00Z for now=2026-06-20, billingDay=DAY_16 (after the day = next month)', () => {
    const now = new Date('2026-06-20T08:00:00.000Z')
    expect(computeNextChargeAt(now, 'DAY_16').toISOString()).toBe('2026-07-16T00:00:00.000Z')
  })

  it('returns 2026-07-06 00:00:00Z for now=2026-06-30, billingDay=DAY_6 (month rolls forward)', () => {
    const now = new Date('2026-06-30T08:00:00.000Z')
    expect(computeNextChargeAt(now, 'DAY_6').toISOString()).toBe('2026-07-06T00:00:00.000Z')
  })

  it('rolls year forward when December billingDay has already passed', () => {
    const now = new Date('2026-12-26T08:00:00.000Z')
    expect(computeNextChargeAt(now, 'DAY_26').toISOString()).toBe('2027-01-26T00:00:00.000Z')
  })

  it('uses 00:00:00.000 UTC for hour / minute / second / ms regardless of the input time-of-day', () => {
    const lateInTheDay = new Date('2026-06-15T23:59:59.999Z')
    const out = computeNextChargeAt(lateInTheDay, 'DAY_16')
    expect(out.getUTCHours()).toBe(0)
    expect(out.getUTCMinutes()).toBe(0)
    expect(out.getUTCSeconds()).toBe(0)
    expect(out.getUTCMilliseconds()).toBe(0)
  })

  it('does not mutate the input `now`', () => {
    const now = new Date('2026-06-15T08:00:00.000Z')
    const snapshot = now.getTime()
    computeNextChargeAt(now, 'DAY_16')
    expect(now.getTime()).toBe(snapshot)
  })

  it('handles all three billingDay values from a single reference date', () => {
    const now = new Date('2026-06-10T12:00:00.000Z')
    // day 10: DAY_6 已過 → 7/6; DAY_16 未過 → 6/16; DAY_26 未過 → 6/26
    expect(computeNextChargeAt(now, 'DAY_6').toISOString()).toBe('2026-07-06T00:00:00.000Z')
    expect(computeNextChargeAt(now, 'DAY_16').toISOString()).toBe('2026-06-16T00:00:00.000Z')
    expect(computeNextChargeAt(now, 'DAY_26').toISOString()).toBe('2026-06-26T00:00:00.000Z')
  })
})
