// Spec 003 §13 — Prisma plugin integration tests against a real Postgres
// testcontainer. Verifies eager connect, round-trip query, graceful close,
// and that a unique constraint violation flows through the spec-005
// errorHandler as RFC 7807 (which exercises mapPrismaError end-to-end).

import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../helpers/app.js'

describe('prisma plugin (integration)', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('decorates app.prisma and answers SELECT 1', async () => {
    app = await buildApp()
    const rows = await app.prisma.$queryRaw<{ one: number }[]>`SELECT 1 as one`
    expect(rows[0]?.one).toBe(1)
  })

  it('round-trips an Account row through Prisma', async () => {
    app = await buildApp()
    const created = await app.prisma.account.create({
      data: { email: 'alice@example.com' },
    })
    const found = await app.prisma.account.findUnique({ where: { id: created.id } })
    expect(found?.email).toBe('alice@example.com')
  })

  it('graceful close — app.close() invokes Prisma $disconnect without error', async () => {
    app = await buildApp()
    // Prisma transparently reconnects on the next query after $disconnect,
    // so we cannot assert subsequent calls fail. The contract this test
    // protects: app.close() must NOT throw, i.e. the onClose hook runs
    // and $disconnect completes cleanly. Any reconnect lifecycle leak
    // would show as an unhandled rejection in the vitest run.
    await expect(app.close()).resolves.toBeUndefined()
    app = undefined
  })

  it('unique violation surfaces as 409 application/problem+json via mapPrismaError', async () => {
    const instance = await buildApp()
    app = instance
    await instance.prisma.account.create({ data: { email: 'dup@example.com' } })

    instance.post('/probe', async () => {
      // Force a P2002 unique constraint violation; errorHandler should
      // convert it to a ConflictError envelope (spec 005 §7.2 / spec 003 §8.1).
      await instance.prisma.account.create({ data: { email: 'dup@example.com' } })
      return { ok: true }
    })

    const res = await instance.inject({ method: 'POST', url: '/probe' })
    expect(res.statusCode).toBe(409)
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/)
    const body = res.json() as { status: number; code: string }
    expect(body.status).toBe(409)
    expect(body.code).toMatch(/UNIQUE_CONSTRAINT|CONFLICT/)
  })
})
