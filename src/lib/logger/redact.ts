// Spec 004 §7.1 — default redaction paths.
//
// Output for matched paths: `"[Redacted]"` (pino default).
//
// MAINTAINERS: any new endpoint that accepts a secret-bearing payload MUST
// extend this list in the same PR (spec 004 §7.2).

export const REDACT_PATHS = [
  // headers
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  // common secret-like body fields
  'req.body.password',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.accessToken',
  'req.body.clientSecret',
  // env snapshot at startup (spec 004 §11.1)
  '*.JWT_SECRET',
  '*.DB_PASSWORD',
  '*.GOOGLE_CLIENT_SECRET',
  '*.password',
]
