// Spec 008 §6.3 / §6.4 / §6.5 (v0.4) — self-service Account CRUD.
//
//   GET    /auth/me   read own profile
//   PATCH  /auth/me   update username / email
//   DELETE /auth/me   soft delete self (set deletedAt + revokeAll refreshes)
//
// All three require an authenticated, non-disabled caller. `requireLiveAccountId`
// (lib/auth/bearer.ts) does signature verify + lifecycle check; that path also
// short-circuits a zombie-session caller (archived/deleted account holding a
// not-yet-expired access JWT — spec 007 §10.9 acknowledges this window).

import { Type } from '@sinclair/typebox'
import type { FastifyInstance } from 'fastify'

import { requireLiveAccountId } from '../../lib/auth/bearer.js'
import { createRefreshStore, type TokenSecrets } from '../../lib/auth/index.js'
import {
  ConflictError,
  ErrorCode,
  UnauthorizedError,
} from '../../lib/errors/index.js'
import { normalizeEmail } from '../../lib/auth/email.js'
import { normalizeUsername, MAX_USERNAME_LENGTH, MIN_USERNAME_LENGTH } from '../../lib/auth/username.js'
import { registerWithV1Alias } from '../../lib/http/index.js'
import type { LimitWindow } from '../../lib/rate-limit/index.js'

interface PatchMeBody {
  username?: string | null
  email?: string | null
}

const ME_READ_USER: LimitWindow = { limit: 60, windowMs: 60 * 1000 } // 1/sec
const ME_PATCH_USER: LimitWindow = { limit: 10, windowMs: 60 * 60 * 1000 } // 10/hour
const ME_DELETE_USER: LimitWindow = { limit: 3, windowMs: 60 * 60 * 1000 } // 3/hour
const ME_ARCHIVE_USER: LimitWindow = { limit: 3, windowMs: 60 * 60 * 1000 } // 3/hour

export interface RegisterMeRoutesDeps {
  tokenSecrets: TokenSecrets
}

export async function registerMeRoutes(
  app: FastifyInstance,
  deps: RegisterMeRoutesDeps,
): Promise<void> {
  const { tokenSecrets } = deps
  const refreshStore = createRefreshStore(app.redis)

  // ── GET /auth/me ───────────────────────────────────────────────────────
  registerWithV1Alias(app, {
    method: 'GET',
    url: '/auth/me',
    config: { rateLimit: { perUser: ME_READ_USER } },
    handler: async (req, reply) => {
      const accountId = await requireLiveAccountId(req, app.prisma, tokenSecrets)
      const account = await app.prisma.account.findUnique({
        where: { id: accountId },
        select: {
          id: true,
          username: true,
          email: true,
          displayOrder: true,
          createdAt: true,
          updatedAt: true,
          lastLoginAt: true,
          lastLoginType: true,
        },
      })
      // requireLiveAccountId already confirmed the row exists; defensive.
      if (!account) {
        throw new UnauthorizedError({
          code: ErrorCode.AUTH_ACCOUNT_DISABLED,
          message: 'Account is disabled',
        })
      }
      return reply.ok({
        id: account.id,
        username: account.username,
        email: account.email,
        displayOrder: account.displayOrder,
        createdAt: account.createdAt.toISOString(),
        updatedAt: account.updatedAt.toISOString(),
        lastLoginAt: account.lastLoginAt?.toISOString() ?? null,
        lastLoginType: account.lastLoginType,
      })
    },
  })

  // ── PATCH /auth/me ─────────────────────────────────────────────────────
  registerWithV1Alias<{ Body: PatchMeBody }>(app, {
    method: 'PATCH',
    url: '/auth/me',
    schema: {
      body: Type.Object({
        username: Type.Optional(
          Type.Union([
            Type.Null(),
            Type.String({
              minLength: MIN_USERNAME_LENGTH,
              maxLength: MAX_USERNAME_LENGTH,
              pattern: '^[a-zA-Z0-9_-]+$',
            }),
          ]),
        ),
        email: Type.Optional(
          Type.Union([Type.Null(), Type.String({ format: 'email', maxLength: 254 })]),
        ),
      }),
    },
    config: { rateLimit: { perUser: ME_PATCH_USER } },
    handler: async (req, reply) => {
      const accountId = await requireLiveAccountId(req, app.prisma, tokenSecrets)

      // Materialise only the fields the caller explicitly touched. `null`
      // means "clear it"; absence (undefined) means "leave it".
      const patch: { username?: string | null; email?: string | null } = {}
      const { username: rawUsername, email: rawEmail } = req.body
      if (rawUsername !== undefined) {
        patch.username = rawUsername === null ? null : normalizeUsername(rawUsername)
      }
      if (rawEmail !== undefined) {
        patch.email = rawEmail === null ? null : normalizeEmail(rawEmail)
      }
      if (Object.keys(patch).length === 0) {
        // No-op PATCH — still return the current profile rather than 400.
        return reply.ok(await selectMe(app, accountId))
      }

      // Spec 007 §10.1 v0.4 — at-least-one identifier rule applies to the
      // post-patch state, not the request body. Fetch current identifiers
      // and compute the effective result of the patch.
      const current = await app.prisma.account.findUnique({
        where: { id: accountId },
        select: { username: true, email: true },
      })
      const effective = {
        username: 'username' in patch ? patch.username : (current?.username ?? null),
        email: 'email' in patch ? patch.email : (current?.email ?? null),
      }
      if (effective.username === null && effective.email === null) {
        throw new UnauthorizedError({
          code: ErrorCode.AUTH_IDENTIFIER_REQUIRED,
          message: 'At least one of username or email is required',
        })
      }

      try {
        await app.prisma.account.update({
          where: { id: accountId },
          data: patch,
        })
      } catch (err) {
        if (isUniqueViolation(err, 'username')) {
          throw new ConflictError({
            code: ErrorCode.AUTH_USERNAME_TAKEN,
            message: 'Username already in use',
            cause: err,
          })
        }
        if (isUniqueViolation(err, 'email')) {
          throw new ConflictError({
            code: ErrorCode.AUTH_EMAIL_TAKEN,
            message: 'Email already in use',
            cause: err,
          })
        }
        throw err
      }

      req.log.info(
        {
          event: 'auth_me_patched',
          accountId,
          audit: true,
          fields: Object.keys(patch),
        },
        'self profile patched',
      )
      return reply.ok(await selectMe(app, accountId))
    },
  })

  // ── POST /auth/me/archive ──────────────────────────────────────────────
  //
  // Action endpoint (not PATCH on `archivedAt`) so the column never appears
  // as a settable field on the self-service /me PATCH body. "Archive" is
  // semantically "shelve me" — admin can later unarchive if/when admin
  // endpoints exist; from the self-service side it's one-way (no self-
  // unarchive because login is blocked once archived).
  registerWithV1Alias(app, {
    method: 'POST',
    url: '/auth/me/archive',
    config: { rateLimit: { perUser: ME_ARCHIVE_USER } },
    handler: async (req, reply) => {
      const accountId = await requireLiveAccountId(req, app.prisma, tokenSecrets)
      await app.prisma.account.update({
        where: { id: accountId },
        data: { archivedAt: new Date() },
      })
      await refreshStore.revokeAll(accountId)
      req.log.info(
        { event: 'auth_me_archived', accountId, audit: true },
        'self archive',
      )
      return reply.noContent()
    },
  })

  // ── DELETE /auth/me ────────────────────────────────────────────────────
  registerWithV1Alias(app, {
    method: 'DELETE',
    url: '/auth/me',
    config: { rateLimit: { perUser: ME_DELETE_USER } },
    handler: async (req, reply) => {
      const accountId = await requireLiveAccountId(req, app.prisma, tokenSecrets)
      // Soft delete (spec 007 §10.9) + sweep ALL refresh tokens so no
      // session survives the self-delete. Access JWT in flight remains
      // valid until expiry (≤ 3h) per ADR 004 zombie-session note.
      await app.prisma.account.update({
        where: { id: accountId },
        data: { deletedAt: new Date() },
      })
      await refreshStore.revokeAll(accountId)
      req.log.info(
        { event: 'auth_me_deleted', accountId, audit: true },
        'self soft delete',
      )
      return reply.noContent()
    },
  })
}

async function selectMe(
  app: FastifyInstance,
  accountId: string,
): Promise<Record<string, unknown>> {
  const a = await app.prisma.account.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      username: true,
      email: true,
      displayOrder: true,
      createdAt: true,
      updatedAt: true,
      lastLoginAt: true,
      lastLoginType: true,
    },
  })
  if (!a) throw new Error('selectMe: account vanished between requireLive and read')
  return {
    id: a.id,
    username: a.username,
    email: a.email,
    displayOrder: a.displayOrder,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    lastLoginAt: a.lastLoginAt?.toISOString() ?? null,
    lastLoginType: a.lastLoginType,
  }
}

function isUniqueViolation(err: unknown, column: string): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { code?: unknown; meta?: { target?: unknown } }
  if (e.code !== 'P2002') return false
  const target = e.meta?.target
  if (Array.isArray(target)) return target.includes(column)
  if (typeof target === 'string') return target.includes(column)
  return false
}

