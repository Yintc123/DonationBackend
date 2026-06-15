// Spec 020 v0.2 §2.3 — Account role enum-equivalent.
//
// Lives as a TypeScript `as const` literal (not a Prisma enum) because the
// role set is demo-stable at two values, and an enum would force a Prisma
// migration for every future split. When MODERATOR / SUPPORT etc. land,
// upgrade `Account.role` to a real enum at that point (recorded in
// spec 020 §14 OQ #1).
//
// `0 = ADMIN`, `1 = USER` — picked specifically so a JWT that lacks a
// `role` claim (old tokens, mis-signed, anything we don't trust) reads as
// `undefined`, which is `!== 0`. Fail-safe: forgetting to set role can
// never accidentally grant admin.

export const Role = {
  ADMIN: 0,
  USER: 1,
} as const

export type RoleValue = (typeof Role)[keyof typeof Role]

/**
 * Type guard for narrowing a `number | undefined` JWT claim into a known
 * `RoleValue`. Anything else (missing / out-of-range / wrong type) returns
 * `false` so the caller falls through to the 403 branch.
 */
export function isRole(value: unknown): value is RoleValue {
  return value === Role.ADMIN || value === Role.USER
}

/**
 * Spec 020 v0.2 §2.3 — read the *current* role from the DB right before
 * issuing an access token. Every issueBundle path (register / password
 * login / google login / google link / refresh) goes through this so a
 * demoted admin loses ADMIN on the next access-token issuance (zombie
 * window ≤ access TTL).
 *
 * Throws if the account is gone or the row carries an unknown role
 * (someone hand-edited the DB) — both are bugs, not user errors.
 */
export async function loadAccountRole(
  prisma: { account: { findUnique: (args: { where: { id: string }; select: { role: true } }) => Promise<{ role: number } | null> } },
  accountId: string,
): Promise<RoleValue> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { role: true },
  })
  if (account === null) {
    throw new Error(`loadAccountRole: account ${accountId} not found`)
  }
  if (!isRole(account.role)) {
    throw new Error(`loadAccountRole: account ${accountId} has invalid role ${account.role}`)
  }
  return account.role
}
