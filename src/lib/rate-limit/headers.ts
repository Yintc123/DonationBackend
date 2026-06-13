// Spec 010 §7 — X-RateLimit-* + Retry-After header builder.
//
// Pure mapper from a list of layer decisions to the header set the
// errorHandler / preHandler stamps onto the reply. Header names live in
// spec 009 §6.2 and the CORS exposed-headers list (spec 012 §3.1) — keep
// these strings in lockstep when either spec changes.

import type { RateLimitLayer } from './keys.js'

export interface LayerDecision {
  layer: RateLimitLayer
  allowed: boolean
  limit: number
  remaining: number
  resetInMs: number
}

export interface BuildHeadersInput {
  decisions: readonly LayerDecision[]
  /** Wall-clock at decision time, used to compute X-RateLimit-Reset (absolute epoch seconds). */
  nowMs: number
}

export interface RateLimitHeaders {
  'X-RateLimit-Limit': string
  'X-RateLimit-Remaining': string
  'X-RateLimit-Reset': string
  /** Only on denial (§7.2). */
  'Retry-After'?: string
  /** Only when multiple layers were considered AND the response is a denial. */
  'X-RateLimit-Layer'?: string
}

/**
 * Pick the "tightest" decision — lowest remaining, ties broken by lowest
 * limit. That layer's limit/remaining/reset go on the response (§7.3).
 */
function tightest(decisions: readonly LayerDecision[]): LayerDecision {
  if (decisions.length === 0) {
    throw new Error('buildRateLimitHeaders: at least one decision required')
  }
  let best: LayerDecision = decisions[0]!
  for (let i = 1; i < decisions.length; i++) {
    const d = decisions[i]!
    if (
      d.remaining < best.remaining ||
      (d.remaining === best.remaining && d.limit < best.limit)
    ) {
      best = d
    }
  }
  return best
}

export function buildRateLimitHeaders(input: BuildHeadersInput): RateLimitHeaders {
  const tightestDecision = tightest(input.decisions)
  const anyDenied = input.decisions.some((d) => !d.allowed)

  // X-RateLimit-Reset = epoch seconds of the window end relative to nowMs.
  const resetEpochSec = Math.ceil((input.nowMs + tightestDecision.resetInMs) / 1000)

  const headers: RateLimitHeaders = {
    'X-RateLimit-Limit': String(tightestDecision.limit),
    'X-RateLimit-Remaining': String(Math.max(0, tightestDecision.remaining)),
    'X-RateLimit-Reset': String(resetEpochSec),
  }

  if (anyDenied) {
    // §7.3 — for the Retry-After we take the LONGEST resetInMs among denied
    // layers, so the client backs off enough to clear them all.
    const longestDenied = input.decisions
      .filter((d) => !d.allowed)
      .reduce((max, d) => Math.max(max, d.resetInMs), 0)
    headers['Retry-After'] = String(Math.max(1, Math.ceil(longestDenied / 1000)))
    headers['X-RateLimit-Layer'] = tightestDecision.layer
  }

  return headers
}
