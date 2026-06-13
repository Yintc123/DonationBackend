// Spec 010 §3 / §5 — flatten plugin defaults + per-route config into the
// list of layer specs the preHandler iterates.
//
// L1 (global per-IP) is ALWAYS present. L2 (route per-IP) is always present
// with the route's override or the plugin default. L3 only when the request
// is authenticated AND the route opted in. L4 zero-or-more purposes.

import type { FastifyRequest } from 'fastify'

import type { RateLimitLayer } from './keys.js'

export interface LimitWindow {
  limit: number
  windowMs: number
}

export interface PurposeConfig {
  /** Unique label — appears in `X-RateLimit-Layer` as `purpose:<name>`. */
  name: string
  limit: number
  windowMs: number
  /**
   * Synchronous (no IO) extractor returning a stable, pre-validated string.
   * The plugin will SHA-256 + truncate it (spec §4.1) — DO NOT pre-hash here.
   */
  identifier?: (req: FastifyRequest) => string
}

export interface RouteRateLimitConfig {
  /** L2 per-IP override. Falls back to plugin default. */
  perIp?: LimitWindow
  /** L3 per-user override. Skipped when the request is unauthenticated. */
  perUser?: LimitWindow
  /** L4 purpose-bound layers. */
  purposes?: PurposeConfig[]
  /** Spec §5.3 — request weight; applies to ALL layers. Default 1. */
  cost?: number
  /** Synchronous bypass; if it returns true the request skips all layers. */
  bypass?: (req: FastifyRequest) => boolean
}

export interface GlobalRateLimitDefaults {
  /** L1 — global per-IP, NOT overridable per route (§5.2). */
  globalPerIp: LimitWindow
  /** L2 default — used when a route omits `perIp`. */
  defaultPerIp: LimitWindow
}

export interface ResolvedLayer {
  layer: RateLimitLayer
  limit: number
  windowMs: number
  cost: number
  /** Only present on `purpose:*` layers — the extractor to call at request time. */
  purposeIdentifier?: (req: FastifyRequest) => string
}

export interface ResolveInput {
  defaults: GlobalRateLimitDefaults
  routeConfig: RouteRateLimitConfig | undefined
  /** Whether the request has an authenticated user (drives L3 emission). */
  hasUser: boolean
}

export function resolveLayerConfig(input: ResolveInput): ResolvedLayer[] {
  const cost = input.routeConfig?.cost ?? 1
  const layers: ResolvedLayer[] = []

  // L1 — never overridable.
  layers.push({
    layer: 'global',
    limit: input.defaults.globalPerIp.limit,
    windowMs: input.defaults.globalPerIp.windowMs,
    cost,
  })

  // L2 — route override or global default.
  const l2 = input.routeConfig?.perIp ?? input.defaults.defaultPerIp
  layers.push({ layer: 'route-ip', limit: l2.limit, windowMs: l2.windowMs, cost })

  // L3 — only when authenticated AND route opted in.
  if (input.hasUser && input.routeConfig?.perUser) {
    layers.push({
      layer: 'route-user',
      limit: input.routeConfig.perUser.limit,
      windowMs: input.routeConfig.perUser.windowMs,
      cost,
    })
  }

  // L4 — purposes (zero or more).
  for (const purpose of input.routeConfig?.purposes ?? []) {
    layers.push({
      layer: `purpose:${purpose.name}` as RateLimitLayer,
      limit: purpose.limit,
      windowMs: purpose.windowMs,
      cost,
      purposeIdentifier: purpose.identifier,
    })
  }

  return layers
}
