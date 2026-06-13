// Spec 003 §3 — Fastify Prisma plugin.
//
// Responsibilities:
//   - Instantiate PrismaClient with config-driven options (spec §3.1)
//   - Eager $connect for fail-fast startup (spec §3.2 — mirrors redis plugin)
//   - Graceful $disconnect on app.close() (spec §3.2)
//   - Wire lifecycle logs into a child logger tagged module=db (spec §13.1)
//
// Business code reaches Prisma only via `app.prisma` — never `new PrismaClient`
// directly (spec §4 — single instance owns DB I/O).

import { PrismaClient } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

import { buildPrismaClientOptions } from './options.js'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
  }
}

export const prismaPlugin = fp(
  async (app: FastifyInstance) => {
    const options = buildPrismaClientOptions(app.config)
    const prisma = new PrismaClient(options)

    const log = app.log.child({ module: 'db' })

    try {
      await prisma.$connect()
      log.info({ event: 'db_connected' }, 'prisma connected')
    } catch (err) {
      log.error({ event: 'db_connect_failed', err }, 'prisma connect failed')
      throw err
    }

    app.decorate('prisma', prisma)

    app.addHook('onClose', async () => {
      await prisma.$disconnect()
      log.info({ event: 'db_disconnected' }, 'prisma disconnected')
    })
  },
  {
    name: 'prisma-plugin',
    fastify: '5.x',
  },
)
