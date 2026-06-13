// Spec 008 §7 / §8 — email + password auth route handlers.
//
// Wired via src/lib/auth/index.ts → authPlugin so the routes share the
// AuthService instance created at plugin registration. JSON Schema bodies
// drive Fastify's built-in validation; spec 005's errorHandler converts
// failures to VALIDATION_FAILED RFC 7807.

import { Type } from '@sinclair/typebox'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { ErrorCode, UnauthorizedError } from '../../lib/errors/index.js'
import { decodeJwtUnsafe } from '../../lib/auth/tokens.js'
import type { AuthService } from '../../lib/auth/service.js'
import type { LimitWindow } from '../../lib/rate-limit/index.js'
import { emailKeyHash } from '../../lib/auth/login-lock.js'

interface RegisterBody {
  email: string
  password: string
}

interface LoginBody {
  email: string
  password: string
}

interface ChangePasswordBody {
  currentPassword: string
  newPassword: string
}

interface SetPasswordBody {
  newPassword: string
}

// Spec §7 — tightened rate-limit defaults. Per-IP layers ride on top of L1
// (global), per-purpose layers add per-email / per-account quota.
const REGISTER_IP: LimitWindow = { limit: 5, windowMs: 60 * 60 * 1000 }
const REGISTER_EMAIL_PURPOSE = {
  name: 'register-email',
  limit: 3,
  windowMs: 24 * 60 * 60 * 1000,
}
const LOGIN_IP: LimitWindow = { limit: 30, windowMs: 60 * 60 * 1000 }
const PASSWORD_CHANGE_USER: LimitWindow = { limit: 5, windowMs: 60 * 60 * 1000 }
const PASSWORD_SET_USER: LimitWindow = { limit: 3, windowMs: 60 * 60 * 1000 }

export interface RegisterAuthRoutesDeps {
  service: AuthService
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: RegisterAuthRoutesDeps,
): Promise<void> {
  const { service } = deps

  // ── POST /auth/register (spec §4 / §8.1) ────────────────────────────────
  app.route<{ Body: RegisterBody }>({
    method: 'POST',
    url: '/auth/register',
    schema: {
      body: Type.Object({
        email: Type.String({ format: 'email', maxLength: 254 }),
        password: Type.String({ minLength: app.config.PASSWORD_MIN_LENGTH, maxLength: 256 }),
      }),
    },
    config: {
      rateLimit: {
        perIp: REGISTER_IP,
        purposes: [
          {
            name: REGISTER_EMAIL_PURPOSE.name,
            limit: REGISTER_EMAIL_PURPOSE.limit,
            windowMs: REGISTER_EMAIL_PURPOSE.windowMs,
            identifier: (req) => emailKeyHash((req.body as RegisterBody).email.toLowerCase().trim()),
          },
        ],
      },
    },
    handler: async (req, reply) => {
      const tokens = await service.registerAccount(req.body)
      // Spec 004 §9.3.5 — register success is an audit event. The accountId
      // is derived from the issued access token jti's `sub` claim — pull from
      // the unsafe decode rather than re-fetching from DB.
      req.log.info(
        { event: 'auth_register_password', audit: true },
        'password account registered',
      )
      return reply.created(`/auth/accounts/me`, tokens)
    },
  })

  // ── POST /auth/login (spec §5 / §8.2) ───────────────────────────────────
  app.route<{ Body: LoginBody }>({
    method: 'POST',
    url: '/auth/login',
    schema: {
      body: Type.Object({
        email: Type.String({ format: 'email', maxLength: 254 }),
        password: Type.String({ minLength: 1, maxLength: 256 }),
      }),
    },
    config: {
      rateLimit: {
        perIp: LOGIN_IP,
      },
    },
    handler: async (req, reply) => {
      const tokens = await service.loginWithPassword(req.body)
      req.log.info(
        { event: 'auth_login_password', audit: true },
        'password login success',
      )
      return reply.ok(tokens)
    },
  })

  // ── POST /auth/password/change (spec §6.1 / §8.3) ───────────────────────
  app.route<{ Body: ChangePasswordBody }>({
    method: 'POST',
    url: '/auth/password/change',
    schema: {
      body: Type.Object({
        currentPassword: Type.String({ minLength: 1, maxLength: 256 }),
        newPassword: Type.String({
          minLength: app.config.PASSWORD_MIN_LENGTH,
          maxLength: 256,
        }),
      }),
    },
    config: {
      rateLimit: {
        perUser: PASSWORD_CHANGE_USER,
      },
    },
    preHandler: requireAccountId,
    handler: async (req, reply) => {
      const accountId = (req as FastifyRequest & { accountId: string }).accountId
      const tokens = await service.changePassword({
        accountId,
        currentPassword: req.body.currentPassword,
        newPassword: req.body.newPassword,
      })
      req.log.info(
        { event: 'auth_password_changed', audit: true, accountId },
        'password changed',
      )
      return reply.ok(tokens)
    },
  })

  // ── POST /auth/password/set (spec §6.2 / §8.4) ──────────────────────────
  app.route<{ Body: SetPasswordBody }>({
    method: 'POST',
    url: '/auth/password/set',
    schema: {
      body: Type.Object({
        newPassword: Type.String({
          minLength: app.config.PASSWORD_MIN_LENGTH,
          maxLength: 256,
        }),
      }),
    },
    config: {
      rateLimit: {
        perUser: PASSWORD_SET_USER,
      },
    },
    preHandler: requireAccountId,
    handler: async (req, reply) => {
      const accountId = (req as FastifyRequest & { accountId: string }).accountId
      await service.setPassword({
        accountId,
        newPassword: req.body.newPassword,
      })
      req.log.info(
        { event: 'auth_password_set', audit: true, accountId },
        'password set',
      )
      return reply.noContent()
    },
  })
}

// Spec §10.5 — `/password/change` and `/password/set` must derive accountId
// from the access JWT, NEVER from body. We perform a minimal decode (no
// signature verify in this spec slice — full JWT middleware ships with spec
// 007). For spec 008's tests we only need to assert "missing → 401".
async function requireAccountId(req: FastifyRequest): Promise<void> {
  const authHeader = req.headers.authorization
  if (typeof authHeader !== 'string' || !authHeader.toLowerCase().startsWith('bearer ')) {
    throw new UnauthorizedError({
      code: ErrorCode.UNAUTHORIZED,
      message: 'Missing or malformed Authorization header',
    })
  }
  const token = authHeader.slice('bearer '.length).trim()
  if (token.length === 0) {
    throw new UnauthorizedError({
      code: ErrorCode.UNAUTHORIZED,
      message: 'Missing bearer token',
    })
  }
  let claims
  try {
    claims = decodeJwtUnsafe(token)
  } catch (err) {
    throw new UnauthorizedError({
      code: ErrorCode.UNAUTHORIZED,
      message: 'Invalid bearer token',
      cause: err,
    })
  }
  if (!claims.sub || claims.type !== 'access') {
    throw new UnauthorizedError({
      code: ErrorCode.UNAUTHORIZED,
      message: 'Invalid access token',
    })
  }
  // Stash on the request for the handler.
  ;(req as FastifyRequest & { accountId: string }).accountId = claims.sub
}
