// Spec 009 §7 — Idempotency-Key Fastify plugin.
//
// Wire-level flow:
//   onRequest   → parse + validate header; stash on request
//   preHandler  → lookup in Redis; on hit, replay or 422 CONFLICT
//   onSend      → on 2xx response, cache for §7.4 24h TTL
//
// Opt-in by header (spec §7.1): clients who want safe retries send
// `Idempotency-Key`. POST without the header behaves identically to before
// — this plugin is invisible. Endpoints that NEED the header (money
// endpoints per §7.1) enforce it via route config `idempotency: 'required'`.
//
// Skip rules:
//   - methods other than POST/PUT/PATCH (idempotency built into HTTP for
//     GET/HEAD/PUT/DELETE per §7.1; PATCH retains opt-in because partial
//     update isn't always semantically idempotent)
//   - /health/* (spec 011 §8 — no auth, no idempotency)

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

import { BadRequestError, UnprocessableEntityError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/codes.js'
import { BODY_METHODS } from './content-negotiation.js'
import {
  buildStorageKey,
  computeEndpointId,
  computeRequestId,
  IDEMPOTENCY_HEADER,
  REPLAY_HEADER,
  validateKey,
} from './idempotency.js'
import {
  createIdempotencyStore,
  type IdempotencyStore,
  type RedisLike,
} from './idempotency-store.js'

// Spec §7.4 — 24-hour TTL. Long enough to cover client retry storms; short
// enough that stale entries don't dominate Redis after a deploy.
const TTL_SEC_24H = 24 * 60 * 60

interface RequestIdempotencyState {
  /** Raw header value (UUID v4 or ULID). Already validated. */
  key: string
  /** Redis key — `cache:idempotency:{endpointId}:{key}`. */
  storageKey: string
  /** Hash of (method, path, body). Populated in preHandler. */
  requestHash?: string
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: RequestIdempotencyState
  }
  interface FastifyContextConfig {
    /** Spec §7.1 — when set, requests without an `Idempotency-Key` header
     *  are rejected with 400 IDEMPOTENCY_KEY_INVALID. Use for money
     *  endpoints / unrepeatable side effects. */
    idempotency?: 'required'
  }
}

class IdempotencyKeyInvalidError extends BadRequestError {
  constructor(reason: 'missing' | 'malformed') {
    super({
      message:
        reason === 'missing'
          ? 'Idempotency-Key header is required for this endpoint'
          : 'Idempotency-Key must be a UUID v4 or ULID',
      code: ErrorCode.IDEMPOTENCY_KEY_INVALID,
      details: { header: 'Idempotency-Key', reason },
    })
  }
}

class IdempotencyKeyConflictError extends UnprocessableEntityError {
  constructor() {
    super({
      message: 'Idempotency-Key has been used for a different request body',
      code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
      details: { header: 'Idempotency-Key' },
    })
  }
}

function isSkippedPath(url: string): boolean {
  return url === '/health' || url.startsWith('/health/')
}

function bodyToString(body: unknown): string {
  if (body === undefined || body === null) return ''
  if (typeof body === 'string') return body
  return JSON.stringify(body)
}

function payloadToString(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (Buffer.isBuffer(payload)) return payload.toString('utf-8')
  // Streams aren't supported — we'd need to tee the stream and that's a
  // future enhancement. For now, opt out by returning empty so we don't
  // poison the cache with [object Object].
  return ''
}

const idempotencyPlugin: FastifyPluginAsync = async (fastify) => {
  let store: IdempotencyStore | undefined

  // Build the store after Redis is decorated — onReady runs once after all
  // plugin registrations (well after redisPlugin).
  //
  // ioredis's overloaded `set()` signature is wider than the narrow
  // RedisLike interface we depend on (set(key, value, mode, ttl, NX)).
  // The cast pins the call shape we actually use.
  fastify.addHook('onReady', async () => {
    const redis: RedisLike = fastify.redis as unknown as RedisLike
    store = createIdempotencyStore({
      redis,
      ttlSec: TTL_SEC_24H,
      logger: fastify.log.child({ module: 'idempotency' }),
    })
  })

  fastify.addHook('onRequest', async (req: FastifyRequest) => {
    if (isSkippedPath(req.url)) return
    if (!BODY_METHODS.has(req.method)) return

    const rawHeader = req.headers[IDEMPOTENCY_HEADER]
    const key = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader
    const required = req.routeOptions?.config?.idempotency === 'required'

    if (!key) {
      if (required) throw new IdempotencyKeyInvalidError('missing')
      return
    }
    if (!validateKey(key).ok) {
      throw new IdempotencyKeyInvalidError('malformed')
    }

    const endpointId = computeEndpointId(req.method, req.url)
    req.idempotency = {
      key,
      storageKey: buildStorageKey(endpointId, key),
    }
  })

  fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const state = req.idempotency
    if (!state || !store) return

    const bodyStr = bodyToString(req.body)
    const requestHash = computeRequestId(req.method, req.url, bodyStr)
    state.requestHash = requestHash

    const hit = await store.lookup(state.storageKey)
    if (!hit) return

    if (hit.requestHash !== requestHash) {
      // Spec §7.4 — same key, different (method/path/body). The caller
      // almost certainly has a bug; surface 422 so they investigate
      // rather than silently mis-replay.
      throw new IdempotencyKeyConflictError()
    }

    // Replay the original response verbatim (spec §7.3). The X-Idempotency-
    // Replay header tells the caller we returned a cached value so they can
    // adjust their own logic (e.g. don't emit a "submitted" toast twice).
    reply
      .status(hit.status)
      .type(hit.contentType)
      .header(REPLAY_HEADER, 'true')
      .header('cache-control', 'no-store')
    if (hit.location) {
      reply.header('location', hit.location)
    }
    return reply.send(hit.body)
  })

  fastify.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload) => {
    const state = req.idempotency
    if (!state || !state.requestHash || !store) return payload
    // Don't re-cache a replay (would be a no-op via SETNX, but skip the work).
    if (reply.getHeader(REPLAY_HEADER)) return payload

    // Only cache successful responses (spec §7.3 — 4xx/5xx must NOT be
    // cached, so the client can retry after fixing input).
    const sc = reply.statusCode
    if (sc < 200 || sc >= 300) return payload

    const bodyStr = payloadToString(payload)
    const contentTypeHeader = reply.getHeader('content-type')
    const locationHeader = reply.getHeader('location')

    await store.save(state.storageKey, {
      status: sc,
      body: bodyStr,
      contentType:
        typeof contentTypeHeader === 'string'
          ? contentTypeHeader
          : 'application/json; charset=utf-8',
      requestHash: state.requestHash,
      location: typeof locationHeader === 'string' ? locationHeader : undefined,
    })

    return payload
  })
}

export default fp(idempotencyPlugin, {
  fastify: '5.x',
  name: 'idempotency',
  dependencies: ['redis-plugin'],
})
