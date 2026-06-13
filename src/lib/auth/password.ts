// Spec 008 §3.1 / §3.2 — Argon2id password hashing wrapper.
//
// Uses `@node-rs/argon2` (Rust binding via napi-rs) per the spec's
// preferred library: roughly 3x faster than the pure-Node `argon2`
// package on the same parameters, with no native-build pain.
//
// The hash / verify / needsRehash signatures are intentionally narrow so
// callers cannot leak raw Argon2 options. Policy is sourced from `Config`
// (PASSWORD_HASH_* + PASSWORD_MIN_LENGTH) at the route / service layer.

import { Algorithm, hash as nodeHash, verify as nodeVerify } from '@node-rs/argon2'

export interface PasswordHashOpts {
  /** Argon2id memoryCost in KiB (spec §3.1 — 2026 default 19456). */
  memoryCost: number
  /** Argon2id iterations (spec §3.1 — 2026 default 2). */
  timeCost: number
  /** Argon2id parallelism (spec §3.1 — 2026 default 1). */
  parallelism: number
  /** Lower bound for plaintext length (spec §3.2 — config-driven, default 8). */
  minLength: number
}

const MAX_PASSWORD_LENGTH = 256 // Spec §3.2 — DoS guard.

// Spec §3.2: reject NULL byte + C0 control chars (0x00-0x1F) and DEL (0x7F).
// We intentionally accept ALL other Unicode (passphrases, emoji), respecting
// NIST SP 800-63B's "length over complexity" principle. Scanning by codepoint
// avoids embedding control bytes in a regex literal (eslint no-control-regex).
function containsControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c <= 0x1f || c === 0x7f) return true
  }
  return false
}

function assertPasswordShape(plain: string, opts: PasswordHashOpts): void {
  if (plain.length < opts.minLength) {
    throw new Error(`password must be at least ${opts.minLength} characters in length`)
  }
  if (plain.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`password must be at most ${MAX_PASSWORD_LENGTH} characters in length`)
  }
  if (containsControlChar(plain)) {
    throw new Error('password contains forbidden control characters')
  }
}

/**
 * Hash a plaintext password with Argon2id and the supplied policy.
 * Throws a generic `Error` on invalid input; callers translate to `AppError`.
 */
export async function hash(plain: string, opts: PasswordHashOpts): Promise<string> {
  assertPasswordShape(plain, opts)
  return nodeHash(plain, {
    algorithm: Algorithm.Argon2id,
    memoryCost: opts.memoryCost,
    timeCost: opts.timeCost,
    parallelism: opts.parallelism,
  })
}

/**
 * Verify a plaintext password against an Argon2 digest. Returns false on a
 * mismatch; throws only when the digest itself is malformed (programmer error,
 * not user-facing).
 */
export async function verify(plain: string, digest: string): Promise<boolean> {
  // We intentionally do NOT validate `plain` here: the calling site already
  // bounds-checked on registration; verify() must accept arbitrary input so
  // login timing stays identical regardless of password shape.
  return nodeVerify(digest, plain)
}

interface ParsedDigestParams {
  memoryCost: number
  timeCost: number
  parallelism: number
}

/**
 * Parse the parameter block out of an Argon2 modular-crypt-format digest.
 * Format: `$argon2id$v=19$m=<mem>,t=<t>,p=<p>$<salt>$<hash>`.
 * Returns undefined when the digest is not the expected shape — callers
 * treat undefined as "needs rehash" so we never trust a malformed digest.
 */
function parseDigestParams(digest: string): ParsedDigestParams | undefined {
  const match = /\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(digest)
  if (!match) return undefined
  return {
    memoryCost: Number(match[1]),
    timeCost: Number(match[2]),
    parallelism: Number(match[3]),
  }
}

/**
 * Returns true when `digest` was produced with weaker parameters than the
 * current policy. Used by login to drive silent rehash (spec §3.1 / §5.1).
 * Returns true for any non-argon2id digest so legacy / malformed hashes
 * get promoted on next login.
 */
export function needsRehash(digest: string, opts: PasswordHashOpts): boolean {
  const params = parseDigestParams(digest)
  if (params === undefined) return true
  return (
    params.memoryCost < opts.memoryCost ||
    params.timeCost < opts.timeCost ||
    params.parallelism !== opts.parallelism
  )
}
