// Spec 005 §4.2 — Aggregate Error Code Dictionary.
//
// SINGLE SOURCE OF TRUTH for infrastructure error codes. The spec table OWNS
// the prose; this module is the runtime mirror business code consumes.
//
// Governance (spec §4.4):
//   - Adding a code: the owning spec MUST update its own §error table AND
//     §4.2 of spec 005 in the same PR. Reviewers block on drift.
//   - HTTP status of a published code is FROZEN — changing it would break
//     client parsers. Add a new code instead.
//   - No cross-prefix reuse (e.g. business code MAY NOT take an AUTH_* /
//     RATE_* / UPSTREAM_* / IDEMPOTENCY_* slot).
//
// Auth (007/008), idempotency (009), rate-limit (010) codes will be added
// here by their owning spec PRs. Only the §4.2.1 generics ship today.

export const ErrorCode = Object.freeze({
  // ── §4.2.1 generic ─────────────────────────────────────────────────────
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  CONFLICT: 'CONFLICT',
  UNPROCESSABLE_ENTITY: 'UNPROCESSABLE_ENTITY',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  UPSTREAM_FAILURE: 'UPSTREAM_FAILURE',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  GATEWAY_TIMEOUT: 'GATEWAY_TIMEOUT',

  // ── §4.2.5 rate limit (spec 010 §11.2) ─────────────────────────────────
  // Surfaced when Redis is unreachable and the fail-closed policy fires.
  RATE_LIMIT_UNAVAILABLE: 'RATE_LIMIT_UNAVAILABLE',

  // ── §4.2.2 auth (spec 008 §9) ──────────────────────────────────────────
  // Owned by spec 008 (email + password).
  AUTH_EMAIL_TAKEN: 'AUTH_EMAIL_TAKEN',
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_ACCOUNT_LOCKED: 'AUTH_ACCOUNT_LOCKED',
  AUTH_PASSWORD_NOT_SET: 'AUTH_PASSWORD_NOT_SET',
  AUTH_PASSWORD_ALREADY_SET: 'AUTH_PASSWORD_ALREADY_SET',

  // ── §4.2.2 auth (spec 007 §12) ─────────────────────────────────────────
  // Owned by spec 007 (Google OIDC + token rotation / logout).
  AUTH_OAUTH_SESSION_INVALID: 'AUTH_OAUTH_SESSION_INVALID',
  AUTH_STATE_MISMATCH: 'AUTH_STATE_MISMATCH',
  AUTH_OAUTH_EXCHANGE_FAILED: 'AUTH_OAUTH_EXCHANGE_FAILED',
  AUTH_ID_TOKEN_INVALID: 'AUTH_ID_TOKEN_INVALID',
  AUTH_EMAIL_UNVERIFIED: 'AUTH_EMAIL_UNVERIFIED',
  AUTH_EMAIL_OWNED_BY_OTHER_ACCOUNT: 'AUTH_EMAIL_OWNED_BY_OTHER_ACCOUNT',
  AUTH_GOOGLE_ALREADY_LINKED: 'AUTH_GOOGLE_ALREADY_LINKED',
  AUTH_CREDENTIAL_EXISTS: 'AUTH_CREDENTIAL_EXISTS',
  AUTH_LINK_SESSION_MISMATCH: 'AUTH_LINK_SESSION_MISMATCH',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_REFRESH_REVOKED: 'AUTH_REFRESH_REVOKED',
  AUTH_REFRESH_REPLAY: 'AUTH_REFRESH_REPLAY',
} as const)

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

// Lookup table: code → HTTP status. Used by Problem Details builder when an
// AppError already carries a statusCode; this exists for code dictionary
// validators / docs generators.
export const ErrorCodeStatus: Readonly<Record<ErrorCodeValue, number>> = Object.freeze({
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.VALIDATION_FAILED]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.METHOD_NOT_ALLOWED]: 405,
  [ErrorCode.UNSUPPORTED_MEDIA_TYPE]: 415,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.UNPROCESSABLE_ENTITY]: 422,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
  [ErrorCode.UPSTREAM_FAILURE]: 502,
  [ErrorCode.UPSTREAM_TIMEOUT]: 504,
  [ErrorCode.GATEWAY_TIMEOUT]: 504,
  [ErrorCode.RATE_LIMIT_UNAVAILABLE]: 503,
  [ErrorCode.AUTH_EMAIL_TAKEN]: 409,
  [ErrorCode.AUTH_INVALID_CREDENTIALS]: 401,
  [ErrorCode.AUTH_ACCOUNT_LOCKED]: 429,
  [ErrorCode.AUTH_PASSWORD_NOT_SET]: 409,
  [ErrorCode.AUTH_PASSWORD_ALREADY_SET]: 409,
  [ErrorCode.AUTH_OAUTH_SESSION_INVALID]: 401,
  [ErrorCode.AUTH_STATE_MISMATCH]: 401,
  [ErrorCode.AUTH_OAUTH_EXCHANGE_FAILED]: 401,
  [ErrorCode.AUTH_ID_TOKEN_INVALID]: 401,
  [ErrorCode.AUTH_EMAIL_UNVERIFIED]: 401,
  [ErrorCode.AUTH_EMAIL_OWNED_BY_OTHER_ACCOUNT]: 409,
  [ErrorCode.AUTH_GOOGLE_ALREADY_LINKED]: 409,
  [ErrorCode.AUTH_CREDENTIAL_EXISTS]: 409,
  [ErrorCode.AUTH_LINK_SESSION_MISMATCH]: 401,
  [ErrorCode.AUTH_TOKEN_EXPIRED]: 401,
  [ErrorCode.AUTH_REFRESH_REVOKED]: 401,
  [ErrorCode.AUTH_REFRESH_REPLAY]: 401,
})
