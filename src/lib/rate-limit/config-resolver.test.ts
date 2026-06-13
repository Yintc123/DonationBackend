// Spec 010 §5 — layer configuration resolution.
//
// resolveLayerConfig merges plugin-global defaults with the per-route
// `config.rateLimit` block into a flat list of layer specs the preHandler can
// evaluate. Pure mapper — no Redis / Fastify required.

import { describe, expect, it } from 'vitest'

import {
  resolveLayerConfig,
  type GlobalRateLimitDefaults,
  type RouteRateLimitConfig,
} from './config-resolver.js'

const GLOBAL_DEFAULTS: GlobalRateLimitDefaults = {
  globalPerIp: { limit: 600, windowMs: 60_000 },
  defaultPerIp: { limit: 120, windowMs: 60_000 },
}

describe('resolveLayerConfig — defaults (spec §3 / §5.2)', () => {
  it('emits L1 global + L2 default per-IP when no route override exists', () => {
    const layers = resolveLayerConfig({
      defaults: GLOBAL_DEFAULTS,
      routeConfig: undefined,
      hasUser: false,
    })
    expect(layers).toEqual([
      { layer: 'global', limit: 600, windowMs: 60_000, cost: 1 },
      { layer: 'route-ip', limit: 120, windowMs: 60_000, cost: 1 },
    ])
  })

  it('does NOT emit L3 when the request is unauthenticated (§3.2 — L3 degrades to L2)', () => {
    const layers = resolveLayerConfig({
      defaults: GLOBAL_DEFAULTS,
      routeConfig: undefined,
      hasUser: false,
    })
    expect(layers.find((l) => l.layer === 'route-user')).toBeUndefined()
  })
})

describe('resolveLayerConfig — per-route overrides (spec §5.1)', () => {
  it('honours perIp override', () => {
    const route: RouteRateLimitConfig = {
      perIp: { limit: 30, windowMs: 60_000 },
    }
    const layers = resolveLayerConfig({
      defaults: GLOBAL_DEFAULTS,
      routeConfig: route,
      hasUser: false,
    })
    const l2 = layers.find((l) => l.layer === 'route-ip')!
    expect(l2.limit).toBe(30)
    expect(l2.windowMs).toBe(60_000)
  })

  it('emits L3 per-user when both hasUser and perUser are set', () => {
    const route: RouteRateLimitConfig = {
      perIp: { limit: 30, windowMs: 60_000 },
      perUser: { limit: 60, windowMs: 60_000 },
    }
    const layers = resolveLayerConfig({
      defaults: GLOBAL_DEFAULTS,
      routeConfig: route,
      hasUser: true,
    })
    expect(layers.map((l) => l.layer)).toContain('route-user')
    const l3 = layers.find((l) => l.layer === 'route-user')!
    expect(l3.limit).toBe(60)
  })

  it('emits L4 purpose layers per the purposes array (§5.1)', () => {
    const route: RouteRateLimitConfig = {
      perIp: { limit: 30, windowMs: 60_000 },
      purposes: [
        { name: 'login_email', limit: 10, windowMs: 3_600_000 },
        { name: 'login_ip', limit: 50, windowMs: 3_600_000 },
      ],
    }
    const layers = resolveLayerConfig({
      defaults: GLOBAL_DEFAULTS,
      routeConfig: route,
      hasUser: false,
    })
    const purposeNames = layers
      .map((l) => l.layer)
      .filter((x): x is `purpose:${string}` => x.startsWith('purpose:'))
    expect(purposeNames).toEqual(['purpose:login_email', 'purpose:login_ip'])
  })

  it('cost flows from route config (default 1) and applies to ALL layers (§5.3)', () => {
    const route: RouteRateLimitConfig = {
      perIp: { limit: 30, windowMs: 60_000 },
      cost: 5,
    }
    const layers = resolveLayerConfig({
      defaults: GLOBAL_DEFAULTS,
      routeConfig: route,
      hasUser: false,
    })
    for (const l of layers) {
      expect(l.cost).toBe(5)
    }
  })

  it('L1 global is NEVER overridable by route config (§5.2)', () => {
    const route: RouteRateLimitConfig = {
      perIp: { limit: 30, windowMs: 60_000 },
    }
    const layers = resolveLayerConfig({
      defaults: GLOBAL_DEFAULTS,
      routeConfig: route,
      hasUser: false,
    })
    const l1 = layers.find((l) => l.layer === 'global')!
    expect(l1.limit).toBe(600)
    expect(l1.windowMs).toBe(60_000)
  })
})
