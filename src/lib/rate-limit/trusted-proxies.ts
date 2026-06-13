// Spec 010 §15.1 / spec 012 §6 — RATE_LIMIT_TRUSTED_PROXIES parser.
//
// Pure helper. The plugin / app bootstrap passes the parsed array into
// Fastify's `trustProxy` option (an array of IPs / CIDRs). Spec 012 §6.2
// forbids `true` — we reject any input that would produce that semantics.

export class TrustedProxyConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TrustedProxyConfigError'
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9.:/]+$/

export function parseTrustedProxies(raw: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (trimmed.length === 0) continue
    if (trimmed === '*' || trimmed.toLowerCase() === 'true') {
      throw new TrustedProxyConfigError(
        'RATE_LIMIT_TRUSTED_PROXIES must not be "*" or "true" — wildcard trust enables IP spoofing (spec 012 §6.2)',
      )
    }
    if (!SAFE_SEGMENT.test(trimmed)) {
      throw new TrustedProxyConfigError(
        `RATE_LIMIT_TRUSTED_PROXIES contains invalid entry "${trimmed}" (only IP / CIDR characters allowed)`,
      )
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed)
      result.push(trimmed)
    }
  }
  return result
}
