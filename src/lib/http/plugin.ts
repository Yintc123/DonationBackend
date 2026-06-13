// Spec 009 — Fastify plugin wiring the success-response conventions:
//   - reply decorators: ok / created / accepted / noContent / paginated
//   - onSend hook propagating X-Request-Id (§6.1)
//
// Error responses (4xx / 5xx) are NOT this plugin's job — they belong to spec
// 005's RFC 7807 error handler.

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'

import { type PaginatedEnvelope, type PaginatedInput, paginatedEnvelope } from './pagination.js'
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

const REQUEST_ID_HEADER = 'x-request-id'

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

  // Spec 009 §6.1 — X-Request-Id on every response, aligned with spec 004 §6.3
  // (`reqId` in logs). We prefer the inbound `X-Request-Id` header when the
  // client supplied one so a BFF / tracing layer can stitch the call chain;
  // otherwise we fall back to Fastify's generated request.id.
  //
  // We deliberately do NOT depend on Fastify's `requestIdHeader` option here —
  // that is set at instance construction time in src/app.ts, outside this
  // plugin's reach. Reading the raw header keeps the plugin self-contained.
  fastify.addHook('onSend', async (request, reply) => {
    if (reply.getHeader(REQUEST_ID_HEADER)) return
    const inbound = request.headers[REQUEST_ID_HEADER]
    const value = typeof inbound === 'string' && inbound.length > 0 ? inbound : request.id
    reply.header(REQUEST_ID_HEADER, value)
  })
}

export default fp(httpResponsePlugin, {
  fastify: '5.x',
  name: 'http-response',
})
