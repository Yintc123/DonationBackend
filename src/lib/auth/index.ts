// Spec 008 — public surface of the email + password auth module.
//
// Exposes the Fastify plugin (`authPlugin`) that wires routes and a small
// set of helpers reused by other modules / tests. The plugin reads config /
// prisma / redis from the parent app (registered earlier in src/app.ts).

import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

import { registerMeRoutes } from '../../routes/auth/me.js'
import { registerAuthRoutes } from '../../routes/auth/password.js'

import type { PasswordHashOpts } from './password.js'
import type { LoginLockOpts } from './login-lock.js'
import { createAuthService } from './service.js'
import type { TokenSecrets } from './tokens.js'

export { normalizeEmail, isValidEmail, MAX_EMAIL_LENGTH } from './email.js'
export {
  hash as hashPassword,
  needsRehash as passwordNeedsRehash,
  verify as verifyPassword,
  type PasswordHashOpts,
} from './password.js'
export {
  isLocked,
  emailKeyHash,
  createLoginLockClient,
  type LoginLockClient,
  type LoginLockOpts,
} from './login-lock.js'
export {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  decodeJwtUnsafe,
  createRefreshStore,
  type IssuedToken,
  type TokenSecrets,
  type RefreshStore,
  type RefreshConsumeOutcome,
  type DecodedClaims,
  type VerifiedAccessClaims,
  type VerifiedRefreshClaims,
} from './tokens.js'
export {
  Role,
  isRole,
  loadAccountRole,
  type RoleValue,
} from './role.js'
export {
  extractBearer,
  isExpiryError,
  requireAccessAccountId,
  requireAccessClaims,
  requireAdmin,
  requireLiveAccountId,
} from './bearer.js'
export { authContextPlugin } from './context.js'
export {
  createAuthService,
  type AuthService,
  type AuthServiceDeps,
  type TokenBundle,
} from './service.js'

export const authPlugin = fp(
  async (app: FastifyInstance) => {
    const cfg = app.config

    const passwordHashOpts: PasswordHashOpts = {
      memoryCost: cfg.PASSWORD_HASH_MEMORY_COST,
      timeCost: cfg.PASSWORD_HASH_TIME_COST,
      parallelism: cfg.PASSWORD_HASH_PARALLELISM,
      minLength: cfg.PASSWORD_MIN_LENGTH,
    }
    const loginLockOpts: LoginLockOpts = {
      threshold: cfg.LOGIN_LOCK_THRESHOLD,
      windowSec: cfg.LOGIN_LOCK_WINDOW_SEC,
    }
    const tokenSecrets: TokenSecrets = {
      accessSecret: cfg.JWT_ACCESS_SECRET,
      refreshSecret: cfg.JWT_REFRESH_SECRET,
      issuer: cfg.JWT_ISSUER,
      audience: cfg.JWT_AUDIENCE || cfg.JWT_ISSUER,
      accessTtlSec: ttlToSeconds(cfg.JWT_ACCESS_EXPIRES_IN, 10800),
      refreshTtlSec: ttlToSeconds(cfg.JWT_REFRESH_EXPIRES_IN, 2592000),
    }

    const service = createAuthService({
      prisma: app.prisma,
      redis: app.redis,
      passwordHashOpts,
      loginLockOpts,
      tokenSecrets,
    })

    // Spec 020 v0.2 §2.3 — expose tokenSecrets to admin routes so they can
    // call `requireAdmin(req, app.prisma, app.tokenSecrets)` without each
    // module rebuilding the secret bundle.
    app.decorate('tokenSecrets', tokenSecrets)

    // Spec 023 §4.1 — `/auth` is one of the three URL surfaces; we mount
    // the spec 008 password routes + spec 008 self-service /me routes
    // under that prefix in a single child plugin so the route file URLs
    // can stay relative (`/register`, `/me`, ...).
    await app.register(
      async (auth) => {
        await registerAuthRoutes(auth, { service })
        await registerMeRoutes(auth, { tokenSecrets })
      },
      { prefix: '/auth' },
    )
  },
  {
    name: 'auth-password',
    fastify: '5.x',
    dependencies: ['prisma-plugin', 'redis-plugin', 'http-response', 'rate-limit'],
  },
)

/**
 * Translates a `<n><unit>` TTL string (e.g. "3h", "30d", "10800s") into
 * seconds. Falls back to `defaultSec` on unrecognised input rather than
 * throwing — the config schema guards against missing values upstream, but
 * we still want a sensible default when env injects e.g. "0".
 */
export function ttlToSeconds(raw: string, defaultSec: number): number {
  const match = raw.trim().match(/^(\d+)\s*([smhd]?)$/i)
  if (!match) return defaultSec
  const n = Number(match[1])
  if (!Number.isFinite(n) || n <= 0) return defaultSec
  const unit = (match[2] || 's').toLowerCase()
  switch (unit) {
    case 's':
      return n
    case 'm':
      return n * 60
    case 'h':
      return n * 60 * 60
    case 'd':
      return n * 24 * 60 * 60
    default:
      return defaultSec
  }
}
