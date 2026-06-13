// Spec 005 §3 — AppError hierarchy.
//
// Single inheritance line: every operational error thrown by app code is (or
// becomes, via mapPrismaError etc.) an AppError. The Fastify global error
// handler then serialises it to RFC 7807 (see ./problem.ts, ./plugin.ts).
//
// Design choices spelled out in spec 005 §3.1:
//   - `code` is a string (SCREAMING_SNAKE_CASE), NOT an enum, so wire-format
//     parity with logs / aggregators is direct.
//   - `expose` defaults to (statusCode < 500). 5xx are opaque to clients;
//     real messages stay in the log. Subclasses may override (rare).
//   - `cause` uses the standard Error.cause (Node 16+), so pino's err
//     serializer walks the chain automatically.

import { ErrorCode } from './codes.js'

export type ErrorDetails = Record<string, unknown> | undefined

export interface AppErrorOptions {
  message: string
  statusCode: number
  code: string
  details?: ErrorDetails
  cause?: unknown
  expose?: boolean
}

export class AppError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly details?: ErrorDetails
  readonly expose: boolean

  constructor(opts: AppErrorOptions) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = new.target.name
    this.statusCode = opts.statusCode
    this.code = opts.code
    this.details = opts.details
    this.expose = opts.expose ?? opts.statusCode < 500
    // Trim the constructor frame from the stack so tests / log readers land on
    // the throw site, not the AppError frame.
    Error.captureStackTrace?.(this, new.target)
  }
}

// ── 4xx ────────────────────────────────────────────────────────────────────

export interface BadRequestOptions {
  message?: string
  code?: string
  details?: ErrorDetails
  cause?: unknown
}

export class BadRequestError extends AppError {
  constructor(opts: BadRequestOptions = {}) {
    super({
      message: opts.message ?? 'Bad request',
      statusCode: 400,
      code: opts.code ?? ErrorCode.BAD_REQUEST,
      details: opts.details,
      cause: opts.cause,
    })
  }
}

export interface ValidationErrorItem {
  path: string
  message: string
  code: string
}

export interface ValidationErrorOptions {
  errors: ValidationErrorItem[]
  message?: string
  code?: string
  cause?: unknown
}

export class ValidationError extends AppError {
  constructor(opts: ValidationErrorOptions) {
    super({
      message: opts.message ?? 'Validation failed',
      statusCode: 400,
      code: opts.code ?? ErrorCode.VALIDATION_FAILED,
      details: { errors: opts.errors },
      cause: opts.cause,
    })
  }
}

export interface AuthErrorOptions {
  message?: string
  code?: string
  details?: ErrorDetails
  cause?: unknown
}

export class UnauthorizedError extends AppError {
  constructor(opts: AuthErrorOptions = {}) {
    super({
      message: opts.message ?? 'Unauthorized',
      statusCode: 401,
      code: opts.code ?? ErrorCode.UNAUTHORIZED,
      details: opts.details,
      cause: opts.cause,
    })
  }
}

export class ForbiddenError extends AppError {
  constructor(opts: AuthErrorOptions = {}) {
    super({
      message: opts.message ?? 'Forbidden',
      statusCode: 403,
      code: opts.code ?? ErrorCode.FORBIDDEN,
      details: opts.details,
      cause: opts.cause,
    })
  }
}

export interface NotFoundOptions {
  resource: string
  id?: string
  message?: string
  code?: string
  cause?: unknown
}

export class NotFoundError extends AppError {
  constructor(opts: NotFoundOptions) {
    super({
      message: opts.message ?? `${opts.resource} not found`,
      statusCode: 404,
      code: opts.code ?? ErrorCode.NOT_FOUND,
      details: { resource: opts.resource, id: opts.id },
      cause: opts.cause,
    })
  }
}

export interface ConflictOptions {
  message?: string
  code?: string
  details?: ErrorDetails
  cause?: unknown
}

export class ConflictError extends AppError {
  constructor(opts: ConflictOptions = {}) {
    super({
      message: opts.message ?? 'Conflict',
      statusCode: 409,
      code: opts.code ?? ErrorCode.CONFLICT,
      details: opts.details,
      cause: opts.cause,
    })
  }
}

export interface UnprocessableEntityOptions {
  message?: string
  code?: string
  details?: ErrorDetails
  cause?: unknown
}

export class UnprocessableEntityError extends AppError {
  constructor(opts: UnprocessableEntityOptions = {}) {
    super({
      message: opts.message ?? 'Unprocessable entity',
      statusCode: 422,
      code: opts.code ?? ErrorCode.UNPROCESSABLE_ENTITY,
      details: opts.details,
      cause: opts.cause,
    })
  }
}

export interface TooManyRequestsOptions {
  retryAfter?: number
  message?: string
  code?: string
  cause?: unknown
}

export class TooManyRequestsError extends AppError {
  constructor(opts: TooManyRequestsOptions = {}) {
    super({
      message: opts.message ?? 'Too many requests',
      statusCode: 429,
      code: opts.code ?? ErrorCode.RATE_LIMITED,
      details: opts.retryAfter !== undefined ? { retryAfter: opts.retryAfter } : undefined,
      cause: opts.cause,
    })
  }
}

// ── 5xx ────────────────────────────────────────────────────────────────────

export interface ServerErrorOptions {
  message?: string
  code?: string
  details?: ErrorDetails
  cause?: unknown
}

export class InternalError extends AppError {
  constructor(opts: ServerErrorOptions = {}) {
    super({
      message: opts.message ?? 'Internal Server Error',
      statusCode: 500,
      code: opts.code ?? ErrorCode.INTERNAL_ERROR,
      details: opts.details,
      cause: opts.cause,
    })
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(opts: ServerErrorOptions = {}) {
    super({
      message: opts.message ?? 'Service Unavailable',
      statusCode: 503,
      code: opts.code ?? ErrorCode.SERVICE_UNAVAILABLE,
      details: opts.details,
      cause: opts.cause,
    })
  }
}

export class GatewayTimeoutError extends AppError {
  constructor(opts: ServerErrorOptions = {}) {
    super({
      message: opts.message ?? 'Gateway Timeout',
      statusCode: 504,
      code: opts.code ?? ErrorCode.GATEWAY_TIMEOUT,
      details: opts.details,
      cause: opts.cause,
    })
  }
}
