// Spec 008 §3.4 (v0.3) — username normalization & validation.
//
// Format: ASCII lowercase alphanumeric + underscore + hyphen,
// length 3-30. Conservative on purpose — avoids unicode confusables,
// avoids characters that would break URL paths or shell commands.
// Storage policy: lowercased, trimmed; unique constraint at DB layer.

export const MIN_USERNAME_LENGTH = 3
export const MAX_USERNAME_LENGTH = 30

const USERNAME_RE = /^[a-z0-9_-]+$/

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase()
}

export function isValidUsername(username: string): boolean {
  if (typeof username !== 'string') return false
  const v = normalizeUsername(username)
  if (v.length < MIN_USERNAME_LENGTH || v.length > MAX_USERNAME_LENGTH) return false
  return USERNAME_RE.test(v)
}

/**
 * Sniff which kind of identifier the caller typed.
 *
 * Login endpoints accept a single `identifier` field so the BFF doesn't
 * have to ask the user up front "is this an email or username?". The
 * presence of `@` is a reliable splitter because the username format
 * forbids it (see USERNAME_RE above).
 */
export function classifyIdentifier(input: string): 'email' | 'username' {
  return input.includes('@') ? 'email' : 'username'
}
