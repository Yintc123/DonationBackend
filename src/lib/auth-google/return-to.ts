// Spec 007 §13.8 + §17 — returnTo redirect-safety gate.
//
// The BFF / browser ultimately consumes `returnTo`. If we accept arbitrary
// values backend-side we hand attackers an open-redirect oracle that lets
// them stage OAuth → consent on legit Google → bounce victim back to a
// malicious site, complete with fresh app session cookies.
//
// Policy:
//   - relative path beginning with `/<single-char-not-/>` — accepted
//     (rejects `//evil.com` which browsers treat as protocol-relative)
//   - absolute http(s) URL whose origin matches an entry in the allowlist
//     — accepted
//   - everything else (other schemes, bare strings, malformed URLs, control
//     chars) — rejected
//
// Allowlist is derived from `CORS_ORIGIN` so we never trust an origin we
// would not also CORS-allow.

const RELATIVE_PATH_RE = /^\/[^/]/

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c <= 0x1f || c === 0x7f) return true
  }
  return false
}

export function parseAllowedReturnOrigins(corsOrigin: string): Set<string> {
  const out = new Set<string>()
  for (const part of corsOrigin.split(',')) {
    const trimmed = part.trim()
    if (trimmed.length === 0) continue
    try {
      const u = new URL(trimmed)
      // Normalise to scheme://host[:port] with no trailing slash.
      out.add(u.origin)
    } catch {
      // Non-URL entries (rare — CORS_ORIGIN validator already accepts these)
      // are silently dropped here; CORS plugin enforces them separately.
    }
  }
  return out
}

export interface ReturnToContext {
  allowedOrigins: Set<string>
}

/**
 * Returns the safe `returnTo` value to round-trip, or `undefined` if the
 * supplied value should be ignored. Callers should treat `undefined` as
 * "fall back to the BFF default" — we do NOT throw because spec §13.8
 * says to ignore-or-reject; ignoring is safer because it does not give
 * a probe oracle for "is this domain whitelisted?".
 */
export function sanitizeReturnTo(
  raw: string | undefined,
  ctx: ReturnToContext,
): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') return undefined
  if (raw.length === 0 || raw.length > 2048) return undefined
  if (hasControlChars(raw)) return undefined

  if (RELATIVE_PATH_RE.test(raw)) return raw

  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    if (!ctx.allowedOrigins.has(u.origin)) return undefined
    return raw
  } catch {
    return undefined
  }
}
