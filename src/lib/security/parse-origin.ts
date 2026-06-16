// Spec 012 §3.1 / §3.3 — CORS_ORIGIN parser.
//
// Two output modes:
//
//   { mode: 'allowlist', origins: string[] }
//     The default. Each request's Origin header is compared against the
//     list; matches get Access-Control-Allow-Origin echoed back, others
//     receive no header. Compatible with `credentials: true`.
//
//   { mode: 'wildcard' }
//     `CORS_ORIGIN` contains `*`. The cors plugin will set
//     `Access-Control-Allow-Origin: *` and force `credentials: false`
//     (W3C forbids `*` + credentials). Safe for this backend because
//     auth runs through Bearer tokens in the Authorization header
//     rather than cookies, so the credentials downgrade doesn't break
//     authenticated calls — JS still attaches Bearer manually.
//
// Wildcard wins when mixed with named origins: the result type is a
// single-mode discriminated union so callers can't fall through both
// branches by accident.

export class CorsOriginConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CorsOriginConfigError'
  }
}

export type CorsOriginConfig =
  | { mode: 'allowlist'; origins: string[] }
  | { mode: 'wildcard' }

export function parseCorsOrigin(raw: string): CorsOriginConfig {
  const seen = new Set<string>()
  const origins: string[] = []
  let wildcard = false

  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    if (trimmed === '*') {
      wildcard = true
      continue
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed)
      origins.push(trimmed)
    }
  }

  if (wildcard) return { mode: 'wildcard' }

  if (origins.length === 0) {
    throw new CorsOriginConfigError(
      'CORS_ORIGIN must list at least one origin (spec 012 §3.1)',
    )
  }

  return { mode: 'allowlist', origins }
}
