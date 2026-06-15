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

import { ErrorCode, UnauthorizedError } from '../errors/index.js'

import { verifyAccessToken, type TokenSecrets } from './tokens.js'

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
  const token = extractBearer(req)
  try {
    const claims = await verifyAccessToken(token, secrets)
    return claims.sub
  } catch (err) {
    const code = isExpiryError(err)
      ? ErrorCode.AUTH_TOKEN_EXPIRED
      : ErrorCode.UNAUTHORIZED
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
