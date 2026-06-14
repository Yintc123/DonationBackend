// Spec 004 §7.1 — default redaction paths.
//
// Output for matched paths: `"[Redacted]"` (pino default).
//
// MAINTAINERS: any new endpoint that accepts a secret-bearing payload MUST
// extend this list in the same PR (spec 004 §7.2). The list is grouped by
// category so it's obvious where a new entry belongs and what's missing.
//
// The `*.<KEY>` wildcards match any property literally named <KEY> at any
// depth — pino does NOT treat `*` as a glob. So `*.JWT_SECRET` matches the
// concrete env key `JWT_SECRET` but NOT `JWT_ACCESS_SECRET`; each variant
// must be enumerated.

export const REDACT_PATHS = [
  // ── Request headers (any HTTP entry point) ─────────────────────────────
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',

  // ── Request body fields (auth flows + token mints) ─────────────────────
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.token',
  'req.body.idToken',
  'req.body.refreshToken',
  'req.body.accessToken',
  'req.body.clientSecret',
  'req.body.code', // OAuth authorization code carries one-shot auth material

  // ── Config snapshot, infrastructure secrets (spec 001 §3.2/§3.3/§3.7) ──
  // DB / cache / connection strings that embed credentials.
  '*.DB_PASSWORD',
  '*.DATABASE_URL', // postgresql://user:password@host/db — password leaks
  '*.REDIS_PASSWORD',

  // ── Config snapshot, AWS credentials (spec 018 §4.1) ───────────────────
  // AWS_ACCESS_KEY_ID is treated like a username (logged in CloudTrail)
  // and intentionally NOT redacted; only the secret half is.
  '*.AWS_SECRET_ACCESS_KEY',

  // ── Config snapshot, auth signing secrets (spec 001 §3.4 / ADR 004) ────
  '*.JWT_ACCESS_SECRET',
  '*.JWT_REFRESH_SECRET',

  // ── Config snapshot, OAuth client credentials (spec 001 §3.5) ──────────
  // GOOGLE_CLIENT_ID is a public identifier, intentionally NOT redacted.
  '*.GOOGLE_CLIENT_SECRET',

  // ── Generic catch-all ──────────────────────────────────────────────────
  // Any object property literally named "password" anywhere in the log
  // record. Defensive cover for ad-hoc objects we forget to enumerate.
  '*.password',
]
