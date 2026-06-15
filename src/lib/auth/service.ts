// Spec 008 §4-§6 — orchestration for email + password auth.
//
// Pure-ish service: takes injected Prisma + Redis + Config + clock so the
// route handlers stay declarative. Each public method maps 1:1 onto a route:
//   - registerAccount      → POST /auth/register   (§4)
//   - loginWithPassword    → POST /auth/login      (§5)
//   - changePassword       → POST /auth/password/change (§6.1)
//   - setPassword          → POST /auth/password/set    (§6.2)
//
// Error policy (spec 005 §5.1):
//   - We throw AppError subclasses with explicit `code` so the global
//     errorHandler emits RFC 7807 with the right `code` field.
//   - Login NEVER discloses which step failed (account missing, no password
//     credential, wrong password) → all paths surface AUTH_INVALID_CREDENTIALS
//     and run a dummy Argon2id hash to equalise timing (spec §5.2).

import type { PrismaClient } from '@prisma/client'
import type { Redis } from 'ioredis'

import {
  ConflictError,
  ErrorCode,
  TooManyRequestsError,
  UnauthorizedError,
} from '../errors/index.js'

import { normalizeEmail } from './email.js'
import {
  createLoginLockClient,
  isLocked,
  type LoginLockOpts,
} from './login-lock.js'
import { hash as hashPassword, needsRehash, verify as verifyPassword } from './password.js'
import type { PasswordHashOpts } from './password.js'
import {
  createRefreshStore,
  signAccessToken,
  signRefreshToken,
  type TokenSecrets,
} from './tokens.js'

// Spec §5.4 — fixed dummy hash run when the account / credential is missing
// so the response time is independent of the lookup path.
const DUMMY_PASSWORD = '!!dummy-for-timing-equalization!!'

export interface AuthServiceDeps {
  prisma: PrismaClient
  redis: Redis
  passwordHashOpts: PasswordHashOpts
  loginLockOpts: LoginLockOpts
  tokenSecrets: TokenSecrets
}

export interface TokenBundle {
  accessToken: string
  accessExpiresIn: number
  refreshToken: string
  refreshExpiresIn: number
  tokenType: 'Bearer'
}

export interface RegisterInput {
  email: string
  password: string
}

export interface LoginInput {
  email: string
  password: string
}

export interface ChangePasswordInput {
  accountId: string
  currentPassword: string
  newPassword: string
}

export interface SetPasswordInput {
  accountId: string
  newPassword: string
}

export interface AuthService {
  registerAccount(input: RegisterInput): Promise<TokenBundle>
  loginWithPassword(input: LoginInput): Promise<TokenBundle>
  changePassword(input: ChangePasswordInput): Promise<TokenBundle>
  setPassword(input: SetPasswordInput): Promise<void>
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const refreshStore = createRefreshStore(deps.redis)
  const loginLock = createLoginLockClient(deps.redis, deps.loginLockOpts)

  async function issueBundle(accountId: string): Promise<TokenBundle> {
    const [access, refresh] = await Promise.all([
      signAccessToken(accountId, deps.tokenSecrets),
      signRefreshToken(accountId, deps.tokenSecrets),
    ])
    await refreshStore.store({
      accountId,
      tokenId: refresh.tokenId,
      token: refresh.token,
      refreshTtlSec: deps.tokenSecrets.refreshTtlSec,
    })
    return {
      accessToken: access.token,
      accessExpiresIn: access.expiresIn,
      refreshToken: refresh.token,
      refreshExpiresIn: refresh.expiresIn,
      tokenType: 'Bearer',
    }
  }

  return {
    async registerAccount(input) {
      const email = normalizeEmail(input.email)
      const hashed = await hashPassword(input.password, deps.passwordHashOpts)
      try {
        // Spec 007 §10.2 / spec 008 §5.4 — register IS an interactive auth
        // event (we issue a token bundle immediately on success), so seed the
        // audit columns at create time. Avoids a redundant UPDATE round-trip.
        const account = await deps.prisma.account.create({
          data: {
            email,
            lastLoginAt: new Date(),
            lastLoginType: 'PASSWORD',
            passwordCredential: {
              create: {
                hashedPassword: hashed,
                hashAlgo: 'argon2id',
              },
            },
          },
        })
        return await issueBundle(account.id)
      } catch (err) {
        // Spec §4.1 — unique constraint on email surfaces as AUTH_EMAIL_TAKEN
        // rather than the generic CONFLICT from mapPrismaError.
        if (isUniqueViolation(err, 'email')) {
          throw new ConflictError({
            code: ErrorCode.AUTH_EMAIL_TAKEN,
            message: 'Email already in use',
            cause: err,
          })
        }
        throw err
      }
    },

    async loginWithPassword(input) {
      const email = normalizeEmail(input.email)

      // Spec §5.3 — block ahead of the password compare when the email is
      // already locked. We still run a dummy hash so timing is uniform.
      const count = await loginLock.getCount(email)
      if (isLocked(count, deps.loginLockOpts)) {
        await runDummyHash()
        throw new TooManyRequestsError({
          code: ErrorCode.AUTH_ACCOUNT_LOCKED,
          message: 'Too many failed attempts. Try again later.',
        })
      }

      const account = await deps.prisma.account.findUnique({
        where: { email },
        include: { passwordCredential: true },
      })

      if (!account || !account.passwordCredential) {
        // Spec §5.2 — equalise timing across "no account" / "no credential"
        // / "wrong password" so timing oracles cannot leak which is which.
        await runDummyHash()
        // We do not record this as a per-email failure because the email
        // might not exist; still, the IP-tier rate-limit catches enumeration.
        throw invalidCredentials()
      }

      const credential = account.passwordCredential
      const ok = await verifyPassword(input.password, credential.hashedPassword)
      if (!ok) {
        const newCount = await loginLock.recordFailure(email)
        if (isLocked(newCount, deps.loginLockOpts)) {
          throw new TooManyRequestsError({
            code: ErrorCode.AUTH_ACCOUNT_LOCKED,
            message: 'Too many failed attempts. Try again later.',
          })
        }
        throw invalidCredentials()
      }

      // Spec §5.1 — silent rehash when params have moved.
      if (needsRehash(credential.hashedPassword, deps.passwordHashOpts)) {
        const rehashed = await hashPassword(input.password, deps.passwordHashOpts)
        await deps.prisma.passwordCredential.update({
          where: { accountId: account.id },
          data: { hashedPassword: rehashed, hashAlgo: 'argon2id' },
        })
      }

      // Spec 007 §10.2 / spec 008 §5.4 — successful login is an interactive
      // auth event. Stamp BEFORE issueBundle so an issueBundle failure
      // doesn't leave the audit stale; the user retries the whole login.
      await deps.prisma.account.update({
        where: { id: account.id },
        data: { lastLoginAt: new Date(), lastLoginType: 'PASSWORD' },
      })

      await loginLock.reset(email)
      return issueBundle(account.id)
    },

    async changePassword({ accountId, currentPassword, newPassword }) {
      const credential = await deps.prisma.passwordCredential.findUnique({
        where: { accountId },
      })
      if (!credential) {
        throw new ConflictError({
          code: ErrorCode.AUTH_PASSWORD_NOT_SET,
          message: 'Password is not set for this account',
        })
      }
      const ok = await verifyPassword(currentPassword, credential.hashedPassword)
      if (!ok) {
        throw invalidCredentials()
      }
      const hashed = await hashPassword(newPassword, deps.passwordHashOpts)
      await deps.prisma.passwordCredential.update({
        where: { accountId },
        data: { hashedPassword: hashed, hashAlgo: 'argon2id' },
      })
      // Spec §6.3 — password change = log out everywhere else.
      await refreshStore.revokeAll(accountId)
      return issueBundle(accountId)
    },

    async setPassword({ accountId, newPassword }) {
      const existing = await deps.prisma.passwordCredential.findUnique({
        where: { accountId },
      })
      if (existing) {
        throw new ConflictError({
          code: ErrorCode.AUTH_PASSWORD_ALREADY_SET,
          message: 'Password is already set',
        })
      }
      const hashed = await hashPassword(newPassword, deps.passwordHashOpts)
      await deps.prisma.passwordCredential.create({
        data: {
          accountId,
          hashedPassword: hashed,
          hashAlgo: 'argon2id',
        },
      })
    },
  }

  async function runDummyHash(): Promise<void> {
    // Result is intentionally discarded. We use the same Argon2 cost as
    // production so the timing matches a real compare.
    await hashPassword(DUMMY_PASSWORD, deps.passwordHashOpts).catch(() => undefined)
  }
}

function invalidCredentials(): UnauthorizedError {
  return new UnauthorizedError({
    code: ErrorCode.AUTH_INVALID_CREDENTIALS,
    message: 'Invalid email or password',
  })
}

// Prisma's P2002 unique violation payload includes `meta.target` listing the
// constraint columns. We check both shapes (array / scalar) since older
// Prisma versions varied.
function isUniqueViolation(err: unknown, column: string): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { code?: unknown; meta?: { target?: unknown } }
  if (e.code !== 'P2002') return false
  const target = e.meta?.target
  if (Array.isArray(target)) return target.includes(column)
  if (typeof target === 'string') return target.includes(column)
  return true // assume unique violation is the email constraint
}
