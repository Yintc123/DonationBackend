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

  // ── §4.2.* pagination (spec 009 §5 / spec 016 §5.1) ───────────────────
  // Emitted by src/lib/cursor/ when a base64url cursor body fails any
  // structural check (alphabet, decode, JSON parse, required fields,
  // type / UUID / ISO-8601 shape).
  PAGINATION_CURSOR_INVALID: 'PAGINATION_CURSOR_INVALID',

  // ── §4.2.* persistence (spec 003 / mapPrismaError) ────────────────────
  // Emitted by src/lib/errors/prisma.ts on Prisma known-request errors.
  // UNIQUE_CONSTRAINT carries the violated columns in details.fields;
  // FK_CONSTRAINT covers both forward (insert pointing at missing row) and
  // reverse (delete blocked by Restrict) FK failures.
  UNIQUE_CONSTRAINT: 'UNIQUE_CONSTRAINT',
  FK_CONSTRAINT: 'FK_CONSTRAINT',

  // ── §4.2.* donation domain query (spec 016 §5.1) ──────────────────────
  // Emitted by src/domain/category/keys.ts parseCategoryKey when the
  // value is well-formed (passes the generic Type.String length bound)
  // but not in the 16-key CATEGORY_KEYS whitelist. Distinct from the
  // generic VALIDATION_FAILED so clients can tell "typo / stale URL"
  // from "schema-level shape error".
  CATEGORY_UNKNOWN: 'CATEGORY_UNKNOWN',

  // ── §4.2.2 auth (spec 008 §9) ──────────────────────────────────────────
  // Owned by spec 008 (email + password).
  AUTH_EMAIL_TAKEN: 'AUTH_EMAIL_TAKEN',
  AUTH_USERNAME_TAKEN: 'AUTH_USERNAME_TAKEN',
  AUTH_IDENTIFIER_REQUIRED: 'AUTH_IDENTIFIER_REQUIRED',
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_ACCOUNT_LOCKED: 'AUTH_ACCOUNT_LOCKED',
  AUTH_ACCOUNT_DISABLED: 'AUTH_ACCOUNT_DISABLED',
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

  // ── §4.2.* storage infra (spec 018 §11.1) ──────────────────────────────
  S3_BUCKET_MISCONFIGURED: 'S3_BUCKET_MISCONFIGURED',
  S3_ACCESS_DENIED: 'S3_ACCESS_DENIED',
  S3_TIMEOUT: 'S3_TIMEOUT',
  S3_UNREACHABLE: 'S3_UNREACHABLE',
  S3_UNKNOWN: 'S3_UNKNOWN',

  // ── §4.2.* donation domain (PLACEHOLDER — spec 015 owns these) ─────────
  // These codes were added by spec 018's presign endpoint (§7.4.1) ahead of
  // spec 015's donation domain landing. They properly belong to spec 015
  // (the owning spec of the Charity / DonationProject / SaleItem entities),
  // not to the storage module that merely references them.
  //
  // Governance debt — when spec 015 PR lands:
  //   1. Move this block under "§4.2.X donation (spec 015)" in this file
  //   2. Add the §error subsection to spec 015 (per spec 005 §4.4)
  //   3. Update spec 018 cross-ref pointer from §7.4.1 to spec 015's §error
  //
  // The codes themselves stay the same; only the spec ownership tag moves.
  CHARITY_NOT_FOUND: 'CHARITY_NOT_FOUND',
  DONATION_PROJECT_NOT_FOUND: 'DONATION_PROJECT_NOT_FOUND',
  SALE_ITEM_NOT_FOUND: 'SALE_ITEM_NOT_FOUND',

  // ── §4.2.* donation order (spec 022 §7) ────────────────────────────────
  // Phase 2 introduces the create endpoints; INVALID_BILLING_DAY is the
  // only one this phase actually throws (TypeBox catches lines-required /
  // too-many at the schema layer with VALIDATION_FAILED). ORDER_NOT_FOUND
  // / ORDER_STATUS_INVALID land with Phase 3 (confirm-payment / cancel /
  // GET / admin PATCH).
  INVALID_BILLING_DAY: 'INVALID_BILLING_DAY',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ORDER_STATUS_INVALID: 'ORDER_STATUS_INVALID',

  // ── §4.2.* donation write API (spec 020 §10) ───────────────────────────
  CHARITY_CATEGORY_INVALID: 'CHARITY_CATEGORY_INVALID',
  INVALID_S3_KEY_BINDING: 'INVALID_S3_KEY_BINDING',
  INVALID_LIFECYCLE_RANGE: 'INVALID_LIFECYCLE_RANGE',
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
  [ErrorCode.PAGINATION_CURSOR_INVALID]: 400,
  [ErrorCode.UNIQUE_CONSTRAINT]: 409,
  [ErrorCode.FK_CONSTRAINT]: 400,
  [ErrorCode.CATEGORY_UNKNOWN]: 400,
  [ErrorCode.AUTH_EMAIL_TAKEN]: 409,
  [ErrorCode.AUTH_USERNAME_TAKEN]: 409,
  [ErrorCode.AUTH_IDENTIFIER_REQUIRED]: 401,
  [ErrorCode.AUTH_INVALID_CREDENTIALS]: 401,
  [ErrorCode.AUTH_ACCOUNT_LOCKED]: 429,
  [ErrorCode.AUTH_ACCOUNT_DISABLED]: 401,
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
  [ErrorCode.CHARITY_NOT_FOUND]: 404,
  [ErrorCode.DONATION_PROJECT_NOT_FOUND]: 404,
  [ErrorCode.SALE_ITEM_NOT_FOUND]: 404,
  [ErrorCode.INVALID_BILLING_DAY]: 400,
  [ErrorCode.ORDER_NOT_FOUND]: 404,
  [ErrorCode.ORDER_STATUS_INVALID]: 409,
  [ErrorCode.CHARITY_CATEGORY_INVALID]: 400,
  [ErrorCode.INVALID_S3_KEY_BINDING]: 400,
  [ErrorCode.INVALID_LIFECYCLE_RANGE]: 400,
  [ErrorCode.S3_BUCKET_MISCONFIGURED]: 500,
  [ErrorCode.S3_ACCESS_DENIED]: 500,
  [ErrorCode.S3_TIMEOUT]: 503,
  [ErrorCode.S3_UNREACHABLE]: 503,
  [ErrorCode.S3_UNKNOWN]: 500,
})
