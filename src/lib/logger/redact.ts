// Spec 004 §7.1 — default redaction paths.
//
// Output for matched paths: `"[Redacted]"` (pino default).
//
// MAINTAINERS: any new endpoint that accepts a secret-bearing payload MUST
// extend this list in the same PR (spec 004 §7.2).
//
// The `*.<KEY>` wildcards match any property literally named <KEY> at any
// depth — pino does NOT treat `*` as a glob. So `*.JWT_SECRET` matches the
// concrete env key `JWT_SECRET` but NOT `JWT_ACCESS_SECRET`; each variant
// must be enumerated.

export const REDACT_PATHS = [
  // headers
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  // common secret-like body fields
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.token',
  'req.body.idToken',
  'req.body.refreshToken',
  'req.body.accessToken',
  'req.body.clientSecret',
  'req.body.code', // OAuth authorization code carries one-shot auth material
  // env snapshot at startup (spec 004 §11.1) — enumerate every Config key
  // that is itself a secret OR contains one inside a URL.
  '*.JWT_ACCESS_SECRET',
  '*.JWT_REFRESH_SECRET',
  '*.DB_PASSWORD',
  '*.DATABASE_URL', // postgresql://user:password@host/db — password leaks
  '*.REDIS_URL', // redis://:password@host — same
  '*.GOOGLE_CLIENT_SECRET',
  '*.password',
]
