// Spec 009 — Fastify plugin wiring the success-response conventions:
//   - reply decorators: ok / created / accepted / noContent / paginated
//   - onSend hook propagating X-Request-Id (§6.1)
//
// Error responses (4xx / 5xx) are NOT this plugin's job — they belong to spec
// 005's RFC 7807 error handler.

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'

import { UnsupportedMediaTypeError } from '../errors/AppError.js'
import {
  BODY_METHODS,
  isAcceptable,
  isJsonContentType,
  requestHasBody,
} from './content-negotiation.js'
import { type PaginatedEnvelope, type PaginatedInput, paginatedEnvelope } from './pagination.js'
import { REQUEST_ID_HEADER, isValidRequestId } from './request-id.js'
import { HttpStatus } from './status.js'

declare module 'fastify' {
  interface FastifyReply {
    /** Spec 009 §3.1 — 200 OK + resource body. */
    ok<T>(body: T): FastifyReply
    /** Spec 009 §3.1 — 201 Created + body, with required Location header (§6.2). */
    created<T>(location: string, body: T): FastifyReply
    /** Spec 009 §3.1 — 202 Accepted + async-task body (e.g. `{ taskId, statusUrl }`). */
    accepted<T>(body: T): FastifyReply
    /** Spec 009 §3.1 — 204 No Content (body MUST be empty). */
    noContent(): FastifyReply
    /** Spec 009 §5.3 — 200 OK + cursor pagination envelope. */
    paginated<T>(input: PaginatedInput<T>): FastifyReply
  }
}

const httpResponsePlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateReply('ok', function (this: FastifyReply, body: unknown) {
    return this.status(HttpStatus.OK).send(body)
  })

  fastify.decorateReply(
    'created',
    function (this: FastifyReply, location: string, body: unknown) {
      return this.status(HttpStatus.CREATED).header('location', location).send(body)
    },
  )

  fastify.decorateReply('accepted', function (this: FastifyReply, body: unknown) {
    return this.status(HttpStatus.ACCEPTED).send(body)
  })

  fastify.decorateReply('noContent', function (this: FastifyReply) {
    // 204 forbids a body; Fastify sends an empty body when send() receives null.
    return this.status(HttpStatus.NO_CONTENT).send()
  })

  fastify.decorateReply('paginated', function (this: FastifyReply, input: PaginatedInput<unknown>) {
    const envelope: PaginatedEnvelope<unknown> = paginatedEnvelope(input)
    return this.status(HttpStatus.OK).send(envelope)
  })

  // Spec 009 §9 — content negotiation guard.
  //
  //   §9.1 Accept       — caller must accept JSON (anything goes if absent).
  //   §9.2 Content-Type — body-bearing POST/PUT/PATCH MUST be application/json.
  //
  // Skipped for /health/* (no body methods anyway; keeps probes simple per
  // spec 011 §8) and for OPTIONS preflight (handled by @fastify/cors).
  fastify.addHook('onRequest', async (request) => {
    if (request.method === 'OPTIONS') return
    if (request.url === '/health' || request.url.startsWith('/health/')) return

    if (!isAcceptable(request.headers.accept)) {
      // Spec §9.1 — 415 because we cannot produce a body the client will
      // accept (RFC 9110 §15.5.16). UNSUPPORTED_MEDIA_TYPE is the same code
      // §9.2 uses; the response code disambiguates by carrying the offending
      // header name in details.
      throw new UnsupportedMediaTypeError({
        message: 'Accept header does not include application/json',
        details: { header: 'Accept' },
      })
    }

    if (BODY_METHODS.has(request.method) && requestHasBody(request.headers)) {
      const ct = request.headers['content-type']
      if (!isJsonContentType(ct)) {
        throw new UnsupportedMediaTypeError({
          message: 'Content-Type must be application/json',
          details: { header: 'Content-Type' },
        })
      }
    }
  })

  // Spec 009 §6.1 — X-Request-Id on every response, aligned with spec 004 §6.3
  // (`reqId` in logs). Prefer the inbound header when it passes spec 012
  // §6.5.2 safety check (charset + length); otherwise fall back to Fastify's
  // generated request.id. See `./request-id.ts` for the rationale.
  fastify.addHook('onSend', async (request, reply) => {
    if (reply.getHeader(REQUEST_ID_HEADER)) return
    const inbound = request.headers[REQUEST_ID_HEADER]
    const value = isValidRequestId(inbound) ? inbound : request.id
    reply.header(REQUEST_ID_HEADER, value)
  })
}

export default fp(httpResponsePlugin, {
  fastify: '5.x',
  name: 'http-response',
})
