// Spec 010 §9.1 / spec 012 §3.6 — exemption predicate.
//
// Pulled into its own pure function so the plugin's preHandler stays trivial
// AND so it is unit-testable without spinning Fastify up. Spec 010 §9.1 owns
// the canonical list; spec 012 §3.6 cross-references for the OPTIONS rule.

interface SkippableRequest {
  method: string
  /** Raw URL (may contain query string). */
  url: string
  /** Fastify-resolved router path, when matched. */
  routerPath?: string
}

const HEALTH_PATHS = new Set([
  '/health',
  '/health/live',
  '/health/ready',
  '/health/startup',
  '/health/db',
  '/health/cache',
])

function pathOnly(url: string): string {
  const q = url.indexOf('?')
  return q >= 0 ? url.slice(0, q) : url
}

export function shouldSkipRateLimit(req: SkippableRequest): boolean {
  // Spec 012 §3.6 — preflight first; cheapest check.
  if (req.method.toUpperCase() === 'OPTIONS') return true

  // Prefer the routerPath (already query-stripped); fall back to the URL.
  const path = req.routerPath ?? pathOnly(req.url)
  return HEALTH_PATHS.has(path)
}
