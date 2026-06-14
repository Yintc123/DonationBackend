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

  // Spec 018 §4.1 / ADR 008 — non-dev runs on ECS Fargate and MUST acquire
  // AWS credentials from the task role. Honouring env-supplied access keys
  // would silently override the role (the SDK credential chain prefers env),
  // leaving a long-lived secret on disk and breaking the audit trail.
  const awsIdSet = config.AWS_ACCESS_KEY_ID !== ''
  const awsSecretSet = config.AWS_SECRET_ACCESS_KEY !== ''
  if (config.NODE_ENV !== 'development' && (awsIdSet || awsSecretSet)) {
    throw new ConfigValidationError(
      'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY must be empty in staging/production (use the ECS task role per ADR 008 / spec 018 §4.1)',
    )
  }

  // Half a credential pair fails silently on the first SDK call ("missing
  // credential" deep inside an S3 PutObject). Catch it at startup regardless
  // of NODE_ENV so the misconfiguration surfaces before traffic.
  if (awsIdSet !== awsSecretSet) {
    throw new ConfigValidationError(
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must both be set or both be empty (spec 018 §4.1)',
    )
  }
}
