// Spec 005 §7.2 / spec 003 §8.1 — Prisma → AppError mapping.
//
// We test against the real `Prisma.PrismaClientKnownRequestError` (no mock,
// no shim) — backend CLAUDE.md mocking policy: don't mock Prisma.

import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'

import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from './AppError.js'
import { mapPrismaError } from './prisma.js'

function makeKnown(code: string, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('synthetic', {
    code,
    clientVersion: 'test',
    meta,
  })
}

describe('mapPrismaError (spec 005 §7.2 / spec 003 §8.1)', () => {
  it('should map P2002 (unique constraint) to ConflictError with code UNIQUE_CONSTRAINT', () => {
    const prismaErr = makeKnown('P2002', { target: ['email'] })

    const mapped = mapPrismaError(prismaErr)

    expect(mapped).toBeInstanceOf(ConflictError)
    expect(mapped?.statusCode).toBe(409)
    expect(mapped?.code).toBe('UNIQUE_CONSTRAINT')
    expect(mapped?.details).toEqual({ fields: ['email'] })
    expect(mapped?.cause).toBe(prismaErr)
  })

  it('should map P2025 (record not found) to NotFoundError', () => {
    const prismaErr = makeKnown('P2025')

    const mapped = mapPrismaError(prismaErr)

    expect(mapped).toBeInstanceOf(NotFoundError)
    expect(mapped?.statusCode).toBe(404)
    expect(mapped?.code).toBe('NOT_FOUND')
    expect(mapped?.cause).toBe(prismaErr)
  })

  it('should map P2003 (foreign key) to BadRequestError with code FK_CONSTRAINT', () => {
    const prismaErr = makeKnown('P2003')

    const mapped = mapPrismaError(prismaErr)

    expect(mapped).toBeInstanceOf(BadRequestError)
    expect(mapped?.statusCode).toBe(400)
    expect(mapped?.code).toBe('FK_CONSTRAINT')
    expect(mapped?.cause).toBe(prismaErr)
  })

  it('should map P2024 (connection pool timeout) to ServiceUnavailableError', () => {
    const prismaErr = makeKnown('P2024')

    const mapped = mapPrismaError(prismaErr)

    expect(mapped).toBeInstanceOf(ServiceUnavailableError)
    expect(mapped?.statusCode).toBe(503)
    expect(mapped?.cause).toBe(prismaErr)
  })

  it('should return undefined for unknown P-codes (spec 003 §8.1 — programmer error)', () => {
    const prismaErr = makeKnown('P9999')

    expect(mapPrismaError(prismaErr)).toBeUndefined()
  })

  it('should return undefined for non-Prisma errors', () => {
    expect(mapPrismaError(new Error('something else'))).toBeUndefined()
    expect(mapPrismaError(null)).toBeUndefined()
    expect(mapPrismaError(undefined)).toBeUndefined()
    expect(mapPrismaError({ code: 'P2002' })).toBeUndefined()
  })
})
