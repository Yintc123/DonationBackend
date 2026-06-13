// Spec 001 §4.4 — cross-field invariants that JSON Schema cannot express.
// Run AFTER @fastify/env successfully loads + validates the schema.

import type { Config } from './schema.js'

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigValidationError'
  }
}

export function postValidate(config: Config): void {
  if (config.NODE_ENV !== 'development' && config.RATE_LIMIT_TRUSTED_PROXIES === '') {
    throw new ConfigValidationError(
      'RATE_LIMIT_TRUSTED_PROXIES must be non-empty in staging/production (spec 001 §4.4 / spec 010 §15.1)',
    )
  }

  if (config.JWT_ACCESS_SECRET === config.JWT_REFRESH_SECRET) {
    throw new ConfigValidationError(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ (spec 001 §3.4 / ADR 004)',
    )
  }
}
