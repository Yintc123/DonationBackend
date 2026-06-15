// Spec 007 §11.5 — bearer-token preHandler helpers shared across auth routes.
//
// `requireAccessAccountId` is the proper-verify version used by every endpoint
// that needs an authenticated caller (Google link / refresh / logout / self-
// service /auth/me/*). It validates HS256 signature + `type=access` claim and
// returns the subject (account UUID).
//
// `requireLiveAccountId` extends that with an Account lifecycle check
// (spec 007 §10.9 — disabled if archived or deleted). Use this on every
// endpoint that should refuse a disabled caller, including the self-service
// /auth/me CRUD endpoints. Refresh stays on the manual check because it also
// has to `revokeAll` on disable, which doesn't fit the generic guard.

import type { PrismaClient } from '@prisma/client'
import type { FastifyRequest } from 'fastify'

import { ErrorCode, ForbiddenError, UnauthorizedError } from '../errors/index.js'

import { Role } from './role.js'
import { verifyAccessToken, type TokenSecrets, type VerifiedAccessClaims } from './tokens.js'

export function extractBearer(req: FastifyRequest): string {
  const authHeader = req.headers.authorization
  if (typeof authHeader !== 'string' || !/^bearer /i.test(authHeader)) {
    throw new UnauthorizedError({
      code: ErrorCode.UNAUTHORIZED,
      message: 'Missing or malformed Authorization header',
    })
  }
  const token = authHeader.slice(7).trim()
  if (token.length === 0) {
    throw new UnauthorizedError({
      code: ErrorCode.UNAUTHORIZED,
      message: 'Missing bearer token',
    })
  }
  return token
}

export function isExpiryError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { code?: unknown }
  return e.code === 'FAST_JWT_EXPIRED'
}

/** Verify the access JWT and return the subject (accountId). No DB hit. */
export async function requireAccessAccountId(
  req: FastifyRequest,
  secrets: TokenSecrets,
): Promise<string> {
  const claims = await requireAccessClaims(req, secrets)
  return claims.sub
}

/**
 * Same verification step as `requireAccessAccountId` but returns the full
 * claim set so callers (`requireAdmin`) can read `role` without a second
 * verify round trip. No DB hit.
 */
export async function requireAccessClaims(
  req: FastifyRequest,
  secrets: TokenSecrets,
): Promise<VerifiedAccessClaims> {
  const token = extractBearer(req)
  try {
    return await verifyAccessToken(token, secrets)
  } catch (err) {
    const code = isExpiryError(err) ? ErrorCode.AUTH_TOKEN_EXPIRED : ErrorCode.UNAUTHORIZED
    throw new UnauthorizedError({
      code,
      message: code === ErrorCode.AUTH_TOKEN_EXPIRED ? 'Token expired' : 'Unauthorized',
      cause: err,
    })
  }
}

/**
 * Verify the JWT AND assert the Account is "live" (not archived / deleted).
 * Returns the account row (selected to the lifecycle columns only) for
 * callers that need them; the accountId is `account.id`.
 *
 * spec 007 §10.9 v0.4 — a disabled account that still holds a valid access
 * JWT (TTL ≤ 3h zombie window) MUST be refused on any endpoint that mutates
 * or reads /auth/me state.
 */
export async function requireLiveAccountId(
  req: FastifyRequest,
  prisma: PrismaClient,
  secrets: TokenSecrets,
): Promise<string> {
  const accountId = await requireAccessAccountId(req, secrets)
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { archivedAt: true, deletedAt: true },
  })
  if (!account || account.archivedAt !== null || account.deletedAt !== null) {
    throw new UnauthorizedError({
      code: ErrorCode.AUTH_ACCOUNT_DISABLED,
      message: 'Account is disabled',
    })
  }
  return accountId
}

/**
 * Spec 020 v0.2 §2.3 — admin gate.
 *
 * Three layered checks: (1) the JWT is a valid `type=access` signature
 * (`requireAccessClaims` — 401 on missing / expired / wrong-type),
 * (2) the Account is not disabled (`requireLiveAccountId`-equivalent — 401
 * AUTH_ACCOUNT_DISABLED, defends against zombie tokens after archive),
 * and (3) the role claim is exactly `Role.ADMIN`. Anything else — including
 * missing `role` (legacy token, hand-crafted JWT, etc.) — falls through to
 * 403 FORBIDDEN by the fail-safe contract in `role.ts`.
 *
 * Returns the verified accountId so the caller can use it for audit
 * payloads without a fourth round trip.
 *
 * **Known accepted limitation (spec 020 §2.3):**
 *   The role claim comes from the JWT, not a fresh DB read. If an admin
 *   was demoted *after* the access token was issued, that token will
 *   still pass for up to one access-token TTL (≤ 3h, ADR 004) — the
 *   "zombie ADMIN" window. We do not maintain an access-token blacklist;
 *   demote re-issuance happens at the next /auth/refresh boundary
 *   (issueBundle re-reads `Account.role` via `loadAccountRole`).
 *   The lifecycle check above does close the matching "archived but
 *   token alive" hole, which is the higher-impact case.
 */
export async function requireAdmin(
  req: FastifyRequest,
  prisma: PrismaClient,
  secrets: TokenSecrets,
): Promise<string> {
  // Step 1+3 together — single verify hit, read role from same claim set.
  const claims = await requireAccessClaims(req, secrets)
  // Step 2 — lifecycle gate. We could short-circuit on non-admin first, but
  // that would leak "this token's role is X" via timing; the DB check is
  // O(index) on a UUID PK so the cost is irrelevant for any role.
  const account = await prisma.account.findUnique({
    where: { id: claims.sub },
    select: { archivedAt: true, deletedAt: true },
  })
  if (!account || account.archivedAt !== null || account.deletedAt !== null) {
    throw new UnauthorizedError({
      code: ErrorCode.AUTH_ACCOUNT_DISABLED,
      message: 'Account is disabled',
    })
  }
  if (claims.role !== Role.ADMIN) {
    throw new ForbiddenError({
      message: 'Admin role required',
    })
  }
  return claims.sub
}
