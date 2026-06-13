// Spec 010 §7 — X-RateLimit-* + Retry-After header builder.
//
// We pick the "tightest" layer (lowest remaining) when multiple layers were
// evaluated, and use that layer's limit / remaining / reset. When the
// decision is a denial, `Retry-After` carries the LONGEST resetInMs of all
// denied layers (§7.3).

import { describe, expect, it } from 'vitest'

import { buildRateLimitHeaders, type LayerDecision } from './headers.js'

const ALLOW = (over: Partial<LayerDecision>): LayerDecision => ({
  allowed: true,
  layer: over.layer ?? 'global',
  limit: over.limit ?? 100,
  remaining: over.remaining ?? 50,
  resetInMs: over.resetInMs ?? 30_000,
})

const DENY = (over: Partial<LayerDecision>): LayerDecision => ({
  allowed: false,
  layer: over.layer ?? 'route-ip',
  limit: over.limit ?? 30,
  remaining: 0,
  resetInMs: over.resetInMs ?? 12_000,
})

describe('buildRateLimitHeaders — allow path (spec §7.1 / §7.3)', () => {
  it('uses the single layer when only one passed', () => {
    const out = buildRateLimitHeaders({
      decisions: [ALLOW({ layer: 'global', limit: 600, remaining: 599, resetInMs: 60_000 })],
      nowMs: 0,
    })
    expect(out['X-RateLimit-Limit']).toBe('600')
    expect(out['X-RateLimit-Remaining']).toBe('599')
    expect(out['X-RateLimit-Reset']).toBe(String(Math.ceil(60_000 / 1000)))
    expect(out['Retry-After']).toBeUndefined()
    expect(out['X-RateLimit-Layer']).toBeUndefined()
  })

  it('picks the layer with the LOWEST remaining (spec §7.3)', () => {
    const out = buildRateLimitHeaders({
      decisions: [
        ALLOW({ layer: 'global', limit: 600, remaining: 599 }),
        ALLOW({ layer: 'route-ip', limit: 30, remaining: 2 }),
        ALLOW({ layer: 'route-user', limit: 60, remaining: 50 }),
      ],
      nowMs: 0,
    })
    expect(out['X-RateLimit-Limit']).toBe('30')
    expect(out['X-RateLimit-Remaining']).toBe('2')
  })

  it('encodes X-RateLimit-Reset as absolute epoch seconds = now + resetInMs', () => {
    const out = buildRateLimitHeaders({
      decisions: [ALLOW({ resetInMs: 25_000 })],
      nowMs: 1_781_000_000_000,
    })
    // (1_781_000_000_000 + 25_000) / 1000 = 1_781_000_025
    expect(out['X-RateLimit-Reset']).toBe('1781000025')
  })
})

describe('buildRateLimitHeaders — deny path (spec §7.2 / §7.3 / §8.1)', () => {
  it('attaches Retry-After (ceil of resetInMs / 1000) and X-RateLimit-Layer', () => {
    const out = buildRateLimitHeaders({
      decisions: [DENY({ layer: 'route-ip', resetInMs: 42_001 })],
      nowMs: 0,
    })
    expect(out['Retry-After']).toBe('43')
    expect(out['X-RateLimit-Layer']).toBe('route-ip')
  })

  it('picks the tightest layer for limit/remaining AND the LONGEST resetInMs for Retry-After (§7.3)', () => {
    const out = buildRateLimitHeaders({
      decisions: [
        DENY({ layer: 'route-ip', limit: 30, resetInMs: 5_000 }),
        DENY({ layer: 'purpose:login_email', limit: 10, resetInMs: 60_000 }),
      ],
      nowMs: 0,
    })
    // tightest = the one with lowest remaining (both 0) → tie broken by lowest limit
    expect(out['X-RateLimit-Limit']).toBe('10')
    expect(out['X-RateLimit-Layer']).toBe('purpose:login_email')
    // Retry-After = longest reset (60s)
    expect(out['Retry-After']).toBe('60')
  })

  it('caps Retry-After at minimum 1 (even when reset is sub-second)', () => {
    const out = buildRateLimitHeaders({
      decisions: [DENY({ resetInMs: 100 })],
      nowMs: 0,
    })
    expect(out['Retry-After']).toBe('1')
  })
})
