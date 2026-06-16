// Spec 009 §9 — Accept + Content-Type negotiation predicates.
//
// Pure functions only. The Fastify wiring (onRequest hook that throws
// UnsupportedMediaTypeError) lives in `plugin.ts` so this file stays
// dependency-free and unit-testable without the framework.
//
// Acceptance policy is deliberately permissive on Accept (spec §9.1 — we
// only refuse explicit non-json) and strict on Content-Type (spec §9.2 —
// POST/PUT/PATCH MUST be JSON; no multipart, no form-urlencoded). This
// asymmetry matches how clients actually behave: browsers send broad
// Accept headers, but POST bodies are something we own.

/** Headers as Fastify exposes them on `req.headers`. */
type HeadersMap = Record<string, string | string[] | undefined>

/**
 * Spec 009 §9.1 — true when the caller will accept `application/json`.
 *
 * No `Accept` header at all is treated as "I'll take anything" per RFC 9110
 * §12.5.1, which is the realistic default for curl / fetch.
 */
export function isAcceptable(header: string | string[] | undefined): boolean {
  if (header === undefined) return true
  const parts = Array.isArray(header) ? header : [header]
  // Flatten "text/html, application/json;q=0.9" → individual media-range tokens.
  const tokens = parts
    .flatMap((line) => line.split(','))
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return true
  return tokens.some((t) => {
    // Drop the `;q=...` / `;charset=...` parameters for matching.
    const range = t.split(';')[0]?.trim()
    if (!range) return false
    if (range === '*/*') return true
    if (range === 'application/*') return true
    if (range === 'application/json') return true
    // RFC 7807 — clients that prefer error JSON should still get success JSON.
    if (range === 'application/problem+json') return true
    return false
  })
}

/**
 * Spec 009 §9.2 — true when Content-Type is `application/json` (with or
 * without charset). Case-insensitive.
 *
 * Returns false for undefined / empty — callers decide whether the absent
 * header is an error (see {@link requestHasBody}).
 */
export function isJsonContentType(header: string | undefined): boolean {
  if (!header) return false
  // Take everything before the first `;` so `application/json; charset=utf-8`
  // still matches without us having to split the parameter list properly.
  const mediaType = header.split(';')[0]?.trim().toLowerCase()
  return mediaType === 'application/json'
}

/**
 * True when the request is going to carry a body. Used to decide whether
 * Content-Type validation applies to POST / PUT / PATCH:
 *   - body-less POST (e.g. POST /auth/logout) does NOT need Content-Type
 *   - body-bearing POST MUST be application/json
 *
 * We treat the request as bodied if either:
 *   - Content-Length parses to > 0, or
 *   - Transfer-Encoding is present (length unknown, but bytes are coming).
 */
export function requestHasBody(headers: HeadersMap): boolean {
  const transferEncoding = headers['transfer-encoding']
  if (typeof transferEncoding === 'string' && transferEncoding.length > 0) return true
  if (Array.isArray(transferEncoding) && transferEncoding.length > 0) return true

  const rawLen = headers['content-length']
  const len = typeof rawLen === 'string' ? Number.parseInt(rawLen, 10) : NaN
  return Number.isFinite(len) && len > 0
}

/** HTTP methods that carry a request body per RFC 9110. */
export const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])
