// Spec 005 §6 — RFC 7807 Problem Details serialiser.
//
// Pure function: AppError + context → response body. The Fastify plugin
// stamps Content-Type and status; this module owns ONLY the body shape.
//
// Title map (code → human-readable phrase) lives here because §6.2 says
// "title and code one-to-one"; keeping them adjacent prevents drift.

import type { AppError } from './AppError.js'

export interface ProblemContext {
  /** Request path WITHOUT query string (spec §6.2 — query strings may carry PII). */
  instance: string
  /** Aligned with `X-Request-Id` header / pino `reqId` (spec 009 §6.1, spec 004 §6.3). */
  requestId: string
  /**
   * Optional doc base URL. With `docsBaseUrl=https://api.example.com`,
   * `type` becomes `https://api.example.com/errors/<code-kebab>`.
   * Without it, falls back to RFC 7807's `about:blank`.
   */
  docsBaseUrl?: string
}

export interface ProblemBody {
  type: string
  title: string
  status: number
  code: string
  detail?: string
  instance: string
  requestId: string
  details?: Record<string, unknown>
}

// Spec §6.2 — title is per-code. Keep adjacent to the code dictionary so a
// reviewer adding a code is forced to add a title in the same patch.
const TITLE_BY_CODE: Record<string, string> = {
  BAD_REQUEST: 'Bad Request',
  VALIDATION_FAILED: 'Validation Failed',
  UNAUTHORIZED: 'Unauthorized',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not Found',
  METHOD_NOT_ALLOWED: 'Method Not Allowed',
  UNSUPPORTED_MEDIA_TYPE: 'Unsupported Media Type',
  CONFLICT: 'Conflict',
  UNPROCESSABLE_ENTITY: 'Unprocessable Entity',
  RATE_LIMITED: 'Too Many Requests',
  RATE_LIMIT_UNAVAILABLE: 'Service Unavailable',
  INTERNAL_ERROR: 'Internal Server Error',
  SERVICE_UNAVAILABLE: 'Service Unavailable',
  UPSTREAM_FAILURE: 'Upstream Failure',
  UPSTREAM_TIMEOUT: 'Upstream Timeout',
  GATEWAY_TIMEOUT: 'Gateway Timeout',
  // Spec 008 §9 — auth (email + password).
  AUTH_EMAIL_TAKEN: 'Email Already In Use',
  AUTH_INVALID_CREDENTIALS: 'Invalid Credentials',
  AUTH_ACCOUNT_LOCKED: 'Account Temporarily Locked',
  AUTH_PASSWORD_NOT_SET: 'Password Not Set',
  AUTH_PASSWORD_ALREADY_SET: 'Password Already Set',
  // Spec 007 §12 — auth (Google OIDC + token rotation / logout).
  AUTH_OAUTH_SESSION_INVALID: 'OAuth Session Invalid',
  AUTH_STATE_MISMATCH: 'OAuth State Mismatch',
  AUTH_OAUTH_EXCHANGE_FAILED: 'OAuth Exchange Failed',
  AUTH_ID_TOKEN_INVALID: 'Identity Token Invalid',
  AUTH_EMAIL_UNVERIFIED: 'Email Not Verified',
  AUTH_EMAIL_OWNED_BY_OTHER_ACCOUNT: 'Email Owned By Another Account',
  AUTH_GOOGLE_ALREADY_LINKED: 'Google Account Already Linked',
  AUTH_CREDENTIAL_EXISTS: 'Credential Already Exists',
  AUTH_LINK_SESSION_MISMATCH: 'Link Session Mismatch',
  AUTH_TOKEN_EXPIRED: 'Token Expired',
  AUTH_REFRESH_REVOKED: 'Refresh Token Revoked',
  AUTH_REFRESH_REPLAY: 'Refresh Token Replay Detected',
}

function codeToKebab(code: string): string {
  return code.toLowerCase().replace(/_/g, '-')
}

function stripQuery(path: string): string {
  const i = path.indexOf('?')
  return i >= 0 ? path.slice(0, i) : path
}

function defaultTitleFor(statusCode: number, code: string): string {
  if (TITLE_BY_CODE[code]) return TITLE_BY_CODE[code]
  // Fallback: derive a Title Case phrase from the code itself.
  if (statusCode >= 500) return 'Internal Server Error'
  return code
    .toLowerCase()
    .split('_')
    .map((part) => (part.length === 0 ? '' : part[0]!.toUpperCase() + part.slice(1)))
    .join(' ')
}

export function toProblem(err: AppError, ctx: ProblemContext): ProblemBody {
  const expose = err.expose
  const instance = stripQuery(ctx.instance)
  const title = expose ? defaultTitleFor(err.statusCode, err.code) : defaultTitleFor(500, err.code)
  const type = ctx.docsBaseUrl
    ? `${ctx.docsBaseUrl.replace(/\/+$/, '')}/errors/${codeToKebab(err.code)}`
    : 'about:blank'

  const body: ProblemBody = {
    type,
    title,
    status: err.statusCode,
    code: err.code,
    instance,
    requestId: ctx.requestId,
  }

  // §6.2 — 5xx with expose=false MUST NOT leak message or details to client.
  if (expose) {
    if (err.message && err.message !== title) {
      body.detail = err.message
    }
    if (err.details !== undefined) {
      body.details = err.details
    }
  }

  return body
}
