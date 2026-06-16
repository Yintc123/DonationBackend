// Spec 009 §7 — Idempotency-Key primitives.
//
// Pure functions only — header validation, endpoint identity, request hash,
// Redis key shape. The Fastify wiring lives in `idempotency-plugin.ts`; the
// Redis-backed store lives in `idempotency-store.ts`. Keeping the pieces
// small lets us unit-test the cryptographic and parsing bits without
// spinning up Redis or Fastify.
//
// Rationale for split:
//   - validateKey:       called once per request → cheap to test exhaustively
//   - computeEndpointId: stable hash of (method, path) — short, used in key
//   - computeRequestId:  full hash of (method, path, body) — for §7.4
//                        IDEMPOTENCY_KEY_CONFLICT detection (server stores
//                        this with the cached response; replay compares)
//   - buildStorageKey:   final Redis key suffix; the @fastify/redis client
//                        adds the project-wide `jkod:` prefix

import { createHash } from 'node:crypto'

// ── Key format validation (spec §7.4) ─────────────────────────────────────

// UUID v4: version nibble = 4, variant nibble = 8/9/a/b.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// ULID: 26 chars Crockford base32. Crockford excludes I, L, O, U to avoid
// visual ambiguity. We accept upper- and lower-case (Crockford itself is
// case-insensitive — both decode to the same value).
const ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i

export interface ValidationResult {
  ok: boolean
}

/**
 * Spec §7.4 — accept UUID v4 or ULID. Anything else is a client bug; we
 * surface 400 IDEMPOTENCY_KEY_INVALID at the call site.
 *
 * Empty string, undefined, path-traversal probes, and tokens that look
 * almost right but fail the version/variant check are all rejected.
 */
export function validateKey(raw: string | undefined): ValidationResult {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false }
  if (UUID_V4_RE.test(raw)) return { ok: true }
  if (ULID_RE.test(raw)) return { ok: true }
  return { ok: false }
}

// ── Identity hashing (spec §7.3, §7.4) ────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function stripQuery(url: string): string {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

/**
 * Spec §7.3 — short, stable id per (method, path). Used in the Redis key
 * so two different endpoints sharing an `Idempotency-Key` don't collide.
 *
 * Method is upper-cased per RFC 9110 (methods are case-insensitive); path
 * is left intact (case-sensitive per RFC 9110 §4.2.3). Query string is
 * stripped — idempotency is scoped to the resource, not the call.
 */
export function computeEndpointId(method: string, url: string): string {
  return sha256Hex(`${method.toUpperCase()}:${stripQuery(url)}`).slice(0, 16)
}

/**
 * Spec §7.4 — full hash of (method, path, body). Stored with the cached
 * response; a replay arrives with the same idempotency key and we compare
 * this hash. Mismatch → 422 IDEMPOTENCY_KEY_CONFLICT (caller-side bug:
 * same key, different intent).
 *
 * Body is passed in as the serialised string. The caller decides whether
 * to use the raw inbound bytes or `JSON.stringify(req.body)` — both are
 * stable for well-behaved JSON clients.
 */
export function computeRequestId(method: string, url: string, body: string): string {
  return sha256Hex(`${method.toUpperCase()}:${stripQuery(url)}:${body}`)
}

// ── Redis key shape (spec §7.3) ───────────────────────────────────────────

/**
 * Spec §7.3 — `cache:idempotency:{endpointId}:{idemKey}`. The `jkod:`
 * project prefix is added by the @fastify/redis client.
 */
export function buildStorageKey(endpointId: string, idemKey: string): string {
  return `cache:idempotency:${endpointId}:${idemKey}`
}

// ── Header name (spec §7.2) ───────────────────────────────────────────────

export const IDEMPOTENCY_HEADER = 'idempotency-key'
export const REPLAY_HEADER = 'x-idempotency-replay'
