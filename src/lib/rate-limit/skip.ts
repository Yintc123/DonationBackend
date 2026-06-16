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

// Spec 016 §12.1 (B5) — Swagger UI bundle lives under /docs and its static
// assets are served by a wildcard route whose routeOptions.url contains '*'.
// That wildcard would otherwise hit assertRouteSafe() in keys.ts and surface
// as a misleading 503 RATE_LIMIT_UNAVAILABLE on every CSS/JS load. The
// openapi plugin is a no-op in production, so this skip is dev-only in
// practice — in prod those paths 404 before any handler runs.
const DOCS_PREFIX = '/docs'

function pathOnly(url: string): string {
  const q = url.indexOf('?')
  return q >= 0 ? url.slice(0, q) : url
}

export function shouldSkipRateLimit(req: SkippableRequest): boolean {
  // Spec 012 §3.6 — preflight first; cheapest check.
  if (req.method.toUpperCase() === 'OPTIONS') return true

  // Prefer the routerPath (already query-stripped); fall back to the URL.
  const path = req.routerPath ?? pathOnly(req.url)
  if (HEALTH_PATHS.has(path)) return true
  // Match `/docs`, `/docs/`, and any `/docs/...` (incl. the literal wildcard
  // routerPath `/docs/static/*`). Reject look-alikes like `/documents`.
  if (path === DOCS_PREFIX || path.startsWith(`${DOCS_PREFIX}/`)) return true
  return false
}
