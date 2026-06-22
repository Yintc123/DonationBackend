// Spec 005 §5 — Fastify global setErrorHandler.
//
// This is THE only place that writes an error response. Route handlers
// throw; this plugin resolves the error to an AppError, serialises to RFC
// 7807, and emits `application/problem+json` with the correct status.
//
// Resolution order (matches spec §5.1):
//   1. Fastify schema validation error  → ValidationError
//   2. Already an AppError              → use as-is
//   3. Known Prisma error               → mapPrismaError
//   4. Anything else                    → opaque InternalError (programmer
//                                          error path, spec §11.2)
//
// MUST be wrapped in `fastify-plugin` so setErrorHandler leaks out of the
// plugin encapsulation and applies to the parent scope. Without fastify-
// plugin, Fastify would scope the handler to this plugin only.
//
// X-Request-Id: the spec-009 http-response plugin already stamps the header
// on the response via its onSend hook. We must produce the SAME value in the
// body's `requestId` field. We share its source of truth (`../http/request-id`)
// so the §6.5.2 safety check (charset + length) applies uniformly across
// success and error responses.

import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

import { REQUEST_ID_HEADER, isValidRequestId } from '../http/request-id.js'
import { AppError, InternalError, NotFoundError, ValidationError } from './AppError.js'
import { mapPrismaError } from './prisma.js'
import { toProblem } from './problem.js'

export interface ErrorHandlerOptions {
  /** RFC 7807 `type` URI base; if unset, falls back to `about:blank`. */
  docsBaseUrl?: string
}

interface FastifyValidationItem {
  instancePath?: string
  message?: string
  keyword?: string
  params?: Record<string, unknown>
}

function isFastifyValidationError(err: unknown): err is FastifyError & {
  validation: FastifyValidationItem[]
} {
  return (
    typeof err === 'object' &&
    err !== null &&
    'validation' in err &&
    Array.isArray((err as { validation: unknown }).validation)
  )
}

function mapFastifyValidationError(
  err: FastifyError & { validation: FastifyValidationItem[] },
): ValidationError {
  const errors = err.validation.map((e) => {
    const paramKey = e.params ? Object.keys(e.params)[0] : undefined
    const code = paramKey ? `${e.keyword ?? 'invalid'}.${paramKey}` : (e.keyword ?? 'invalid')
    return {
      path: e.instancePath ?? '',
      message: e.message ?? 'invalid',
      code,
    }
  })
  return new ValidationError({ errors, cause: err })
}

function resolveRequestId(request: FastifyRequest): string {
  const inbound = request.headers[REQUEST_ID_HEADER]
  return isValidRequestId(inbound) ? inbound : request.id
}

function resolveAppError(err: unknown): AppError {
  if (err instanceof AppError) return err
  if (isFastifyValidationError(err)) return mapFastifyValidationError(err)
  const prismaMapped = mapPrismaError(err)
  if (prismaMapped) return prismaMapped
  // Programmer error path (spec §11.2): opaque 500, original message stays
  // in the cause chain so pino's errSerializer logs it.
  return new InternalError({ cause: err })
}

const errorHandlerPlugin: FastifyPluginAsync<ErrorHandlerOptions> = async (fastify, opts) => {
  const docsBaseUrl = opts.docsBaseUrl

  fastify.setErrorHandler(
    (err: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
      const appErr = resolveAppError(err)

      // Spec §10.1 logging levels:
      //   - 5xx (incl. programmer error) → error  (errSerializer walks cause)
      //   - 401 / 403                    → warn   (suspicious traffic)
      //   - other 4xx                    → info   (client error, normal)
      const log = request.log
      if (appErr.statusCode >= 500) {
        log.error({ err: appErr, code: appErr.code, statusCode: appErr.statusCode }, appErr.message)
      } else if (appErr.statusCode === 401 || appErr.statusCode === 403) {
        log.warn({ err: appErr, code: appErr.code, statusCode: appErr.statusCode }, appErr.message)
      } else {
        log.info({ err: appErr, code: appErr.code, statusCode: appErr.statusCode }, appErr.message)
      }

      const requestId = resolveRequestId(request)
      const body = toProblem(appErr, {
        instance: request.url,
        requestId,
        docsBaseUrl,
      })

      // Set our own X-Request-Id so the body and header always agree, even
      // when the spec-009 http-response plugin isn't registered (e.g. this
      // unit test) and even on 5xx where its onSend hook would still run.
      //
      // Spec 017 §2 v0.6 / spec 005 — error responses MUST NOT be cached.
      // Required for the cascading-visibility scenario (Charity contract
      // expires → child Project 404 → contract renewed → child 200): a CDN
      // that caches the 404 would keep serving "gone" after the parent is
      // back. Applies uniformly to all 4xx and 5xx — `no-store` on errors
      // is a safe default; any future cacheable error response (none today)
      // can override here.
      reply
        .status(appErr.statusCode)
        .type('application/problem+json; charset=utf-8')
        .header(REQUEST_ID_HEADER, requestId)
        .header('Cache-Control', 'no-store')
        .send(body)
    },
  )

  // Spec 005 §5.3 — Fastify's default 404 returns a plain text body. Route
  // it through the same Problem Details pipeline so every error response
  // (route exists / route doesn't) shares one wire shape. We throw and let
  // the setErrorHandler above own the writing.
  fastify.setNotFoundHandler((request: FastifyRequest, _reply: FastifyReply) => {
    throw new NotFoundError({ resource: request.url })
  })
}

// fastify-plugin wraps to skip encapsulation so setErrorHandler applies to
// the parent app scope (spec §5; matches buildApp() registration pattern).
export default fp(errorHandlerPlugin, {
  fastify: '5.x',
  name: 'error-handler',
})
