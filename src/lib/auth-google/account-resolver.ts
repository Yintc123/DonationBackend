// Spec 007 §10.3 / §10.5 — Google login intent decision tree.
//
// Pure function over abstract lookups (so the resolver itself never touches
// Prisma). The route layer wires the lookups to the real Prisma client and
// performs any required mutation inside a single transaction (§10.4).
//
// Outcomes mirror the spec table:
//   - login    : GoogleCredential exists → sign tokens for that account
//   - register : neither sub nor email present → create Account + Credential
//   - collision: email belongs to a different account that has no Google
//                credential. Spec §10.5 says we MUST 409 (no auto-link).
//
// The link intent (§10.6) is handled by a separate function (`resolveGoogleLink`)
// because its preconditions are different (caller is already authenticated).

export interface GoogleIdentity {
  sub: string
  email: string
}

export interface GoogleLookups {
  /** Resolve to the Account that owns the given Google `sub`, if any. */
  findAccountByGoogleSub(sub: string): Promise<{ id: string } | null>
  /** Resolve to the Account that owns the given email, if any. */
  findAccountByEmail(emailLowercase: string): Promise<{ id: string } | null>
}

export type GoogleLoginResolution =
  | { action: 'login'; accountId: string }
  | { action: 'register'; email: string; sub: string }
  | { action: 'collision'; existingAccountId: string }

export async function resolveGoogleLogin(
  identity: GoogleIdentity,
  lookups: GoogleLookups,
): Promise<GoogleLoginResolution> {
  const email = identity.email.toLowerCase()

  const linked = await lookups.findAccountByGoogleSub(identity.sub)
  if (linked) {
    return { action: 'login', accountId: linked.id }
  }

  const owner = await lookups.findAccountByEmail(email)
  if (owner) {
    return { action: 'collision', existingAccountId: owner.id }
  }

  return { action: 'register', email, sub: identity.sub }
}

// ── Link intent (spec §10.6) ─────────────────────────────────────────────

export interface GoogleLinkLookups {
  /** Resolve to the Account that owns the given Google `sub`, if any. */
  findAccountByGoogleSub(sub: string): Promise<{ id: string } | null>
  /** True when the given Account already has a GoogleCredential row. */
  accountHasGoogleCredential(accountId: string): Promise<boolean>
}

export type GoogleLinkResolution =
  | { action: 'link' }
  | { action: 'already-linked-elsewhere' }
  | { action: 'credential-exists' }

/**
 * Decide whether an already-authenticated user may add a GoogleCredential.
 *
 * Spec §10.6 precondition checks (BEFORE the credential is created):
 *   - if the Google sub is already linked to ANOTHER account →
 *     409 AUTH_GOOGLE_ALREADY_LINKED
 *   - if the current account ALREADY has a Google credential →
 *     409 AUTH_CREDENTIAL_EXISTS
 *   - otherwise → link
 */
export async function resolveGoogleLink(
  currentAccountId: string,
  identity: GoogleIdentity,
  lookups: GoogleLinkLookups,
): Promise<GoogleLinkResolution> {
  const linked = await lookups.findAccountByGoogleSub(identity.sub)
  if (linked && linked.id !== currentAccountId) {
    return { action: 'already-linked-elsewhere' }
  }
  // Same account already linked? Treat as credential-exists.
  const has = await lookups.accountHasGoogleCredential(currentAccountId)
  if (has) {
    return { action: 'credential-exists' }
  }
  return { action: 'link' }
}
