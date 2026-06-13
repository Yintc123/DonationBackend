// Spec 003 §3 — Prisma client construction options derived from Config.
//
// Kept in its own file (no Prisma import here) so unit tests can assert
// the option shape without paying the cost of @prisma/client's heavy
// generated module.

import type { Config } from '../../config/schema.js'

export interface PrismaClientOptions {
  datasourceUrl: string
}

export function buildPrismaClientOptions(config: Config): PrismaClientOptions {
  return {
    datasourceUrl: config.DATABASE_URL,
  }
}
