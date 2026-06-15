// Spec 010 §4 — rate-limit key builders.
//
// All keys live under the `jkod:rate:*` namespace (spec 006 §5 — `rate` tier).
// Stored layer key shapes (§4) — the `jkod:` prefix is applied by ioredis:
//   L1 global per-IP        jkod:rate:global:ip:{ip}:{windowStart}
//   L2 per-route per-IP     jkod:rate:route:{routeId}:ip:{ip}:{windowStart}
//   L3 per-route per-user   jkod:rate:route:{routeId}:user:{userId}:{windowStart}
//   L4 per-purpose          jkod:rate:purpose:{purposeName}:{identifierHash}:{windowStart}
//
// We use the existing buildKey() from src/lib/redis so the segment validation
// regex (no whitespace, no SCAN metacharacters) stays in one place. The
// `jkod:` app prefix is applied by ioredis via `keyPrefix`, NOT by buildKey
// or by us. IPv6 colons would collide with the segment separator, so we
// normalise colons → dots before handing the IP to buildKey().

import { createHash } from 'node:crypto'

import { buildKey } from '../redis/index.js'

// Spec 006 §4.3 forbids whitespace + SCAN metacharacters (* ? [ ]). The
// generic buildKey() validator is conservative and also rejects `/`, which
// rate-limit keys legitimately need inside routeId segments (e.g. POST:/v1/x).
// We re-validate per spec §4.3 here for route-bearing segments and assemble
// the key manually instead of going through buildKey for those layers.
const ROUTE_FORBIDDEN = /[\s*?[\]]/
function assertRouteSafe(segment: string, context: string): void {
  if (segment.length === 0) {
    throw new Error(`rateLimitKey(${context}): empty segment not allowed`)
  }
  if (ROUTE_FORBIDDEN.test(segment)) {
    throw new Error(
      `rateLimitKey(${context}): segment "${segment}" must not contain whitespace or SCAN metacharacters`,
    )
  }
}

/** Layer tags used both in Redis keys and the `X-RateLimit-Layer` header. */
export type RateLimitLayer = 'global' | 'route-ip' | 'route-user' | `purpose:${string}`

export interface RateLimitKeyArgs {
  layer: 'global' | 'route-ip' | 'route-user' | 'purpose'
  windowStartMs: number
  /** L1 / L2 */
  ip?: string
  /** L2 / L3 */
  routeId?: string
  /** L3 */
  userId?: string
  /** L4 */
  purposeName?: string
  /** L4 — pre-hashed identifier (spec §4.1) */
  identifierHash?: string
}

/**
 * Floor a millisecond timestamp to its window-aligned bucket start.
 * Used by both the key builder and the Lua script's `elapsed` calculation.
 */
export function windowStartMs(nowMs: number, windowMs: number): number {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('windowStartMs: windowMs must be a positive number')
  }
  return Math.floor(nowMs / windowMs) * windowMs
}

/**
 * Normalise an IP for use as a key segment. IPv6 uses `:` as its own
 * separator which collides with our key separator AND would re-introduce
 * SCAN metacharacters in some cases — replace with `.`. IPv4 passes through.
 */
export function ipToSegment(ip: string): string {
  if (typeof ip !== 'string' || ip.trim().length === 0) {
    throw new Error('ipToSegment: ip must be a non-empty string')
  }
  return ip.replace(/:/g, '.')
}

/**
 * SHA-256 hash of an identifier (e.g. email) truncated to 16 hex chars.
 * Spec §4.1 — PII identifiers MUST be hashed before going into Redis.
 */
export function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

export interface RouteIdInput {
  method: string
  routerPath: string | undefined
  url?: string
}

/**
 * Build the routeId used in L2 / L3 keys: `<METHOD>:<routePath>`.
 * Falls back to the raw URL when routerPath is missing (404 / un-matched).
 * routerPath would be undefined inside a preHandler running before route
 * resolution but Fastify resolves the route BEFORE preHandler hooks fire, so
 * routerPath should be present in practice.
 */
export function routeIdFromRequest(input: RouteIdInput): string {
  const method = input.method.toUpperCase()
  const path = input.routerPath ?? input.url ?? '<unknown>'
  return `${method}:${path}`
}

/** Build the full Redis key for a layer's sliding-window bucket. */
export function rateLimitKey(args: RateLimitKeyArgs): string {
  const win = String(args.windowStartMs)

  switch (args.layer) {
    case 'global': {
      if (!args.ip) throw new Error('rateLimitKey(global): ip is required')
      return buildKey('rate', ['global', 'ip', ipToSegment(args.ip), win])
    }
    case 'route-ip': {
      if (!args.routeId || !args.ip) {
        throw new Error('rateLimitKey(route-ip): routeId and ip are required')
      }
      assertRouteSafe(args.routeId, 'route-ip')
      return `rate:route:${args.routeId}:ip:${ipToSegment(args.ip)}:${win}`
    }
    case 'route-user': {
      if (!args.routeId || !args.userId) {
        throw new Error('rateLimitKey(route-user): routeId and userId are required')
      }
      assertRouteSafe(args.routeId, 'route-user')
      assertRouteSafe(args.userId, 'route-user')
      return `rate:route:${args.routeId}:user:${args.userId}:${win}`
    }
    case 'purpose': {
      if (!args.purposeName || !args.identifierHash) {
        throw new Error('rateLimitKey(purpose): purposeName and identifierHash are required')
      }
      return buildKey('rate', ['purpose', args.purposeName, args.identifierHash, win])
    }
  }
}
