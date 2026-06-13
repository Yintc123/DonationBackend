// Spec 008 §3.3 — Email normalization & validation.
//
// Storage policy: lowercased, trimmed; plus-addressing aliases preserved.
// The DB layer has a UNIQUE constraint on the normalized form, so we always
// pass the output of `normalizeEmail` into `prisma.account.*` lookups.

export const MAX_EMAIL_LENGTH = 254 // RFC 5321 §4.5.3.1.3

// Conservative RFC 5322 simplification — same shape as
// JSON Schema `format: 'email'` (used in route schemas).
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

export function normalizeEmail(email: string): string {
  const trimmed = email.trim()
  if (trimmed.length > MAX_EMAIL_LENGTH) {
    throw new Error(`email exceeds max length ${MAX_EMAIL_LENGTH}`)
  }
  return trimmed.toLowerCase()
}

export function isValidEmail(email: string): boolean {
  if (typeof email !== 'string') return false
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return false
  return EMAIL_RE.test(email)
}
