// Spec 005 §7.2 — Prisma → AppError mapping.
//
// Only Prisma codes explicitly enumerated in spec 003 §8.1 are mapped.
// Unknown codes return undefined; the Fastify error handler then treats the
// situation as a programmer error (spec §11.2) and emits an opaque 500.
//
// Live in src/lib/errors/ (NOT src/lib/db/) because the implementation is
// owned by spec 005 — spec 003 §8.2 expressly defers the table here.

import { Prisma } from '@prisma/client'

import type { AppError } from './AppError.js'
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from './AppError.js'
import { ErrorCode } from './codes.js'

export function mapPrismaError(err: unknown): AppError | undefined {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return undefined

  switch (err.code) {
    case 'P2002': {
      // Unique constraint — Prisma stores violated columns in meta.target.
      const target = err.meta?.target
      return new ConflictError({
        message: 'Unique constraint violated',
        code: ErrorCode.UNIQUE_CONSTRAINT,
        details: target !== undefined ? { fields: target } : undefined,
        cause: err,
      })
    }
    case 'P2025':
      return new NotFoundError({ resource: 'record', cause: err })
    case 'P2003':
      return new BadRequestError({
        message: 'Foreign key constraint failed',
        code: ErrorCode.FK_CONSTRAINT,
        cause: err,
      })
    case 'P2024':
      return new ServiceUnavailableError({
        message: 'Database pool timeout',
        cause: err,
      })
    default:
      // Unknown P-code → programmer error path (spec §11.2 via plugin).
      return undefined
  }
}
