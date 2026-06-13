// Spec 012 §3.1 / §3.3 — CORS_ORIGIN parser.
//
// The raw env value is a comma-separated list. We:
//   - trim each entry,
//   - drop empties,
//   - dedupe,
//   - reject the literal "*" (spec 012 §3.2 — wildcard + credentials forbidden).
//
// Result is a stable array preserving first-occurrence order. The caller
// (cors plugin) turns this into a Set + per-request exact match.

export class CorsOriginConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CorsOriginConfigError'
  }
}

export function parseCorsOrigin(raw: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    if (trimmed === '*') {
      throw new CorsOriginConfigError(
        'CORS_ORIGIN must not contain the wildcard "*" (spec 012 §3.2)',
      )
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed)
      result.push(trimmed)
    }
  }

  if (result.length === 0) {
    throw new CorsOriginConfigError(
      'CORS_ORIGIN must list at least one origin (spec 012 §3.1)',
    )
  }

  return result
}
