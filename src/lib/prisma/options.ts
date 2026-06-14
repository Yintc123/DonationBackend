// Spec 003 §3 — Prisma client construction options derived from Config.
//
// Kept in its own file (no Prisma import here) so unit tests can assert
// the option shape without paying the cost of @prisma/client's heavy
// generated module.
//
// `datasourceUrl` overrides schema.prisma's `env("DATABASE_URL")` at
// PrismaClient construction. The application therefore never depends on
// `DATABASE_URL` being in env — DB_* parts are the single source of truth
// (spec 001 §3.2). The composer is the one place that turns them into a
// URL; CLI-level Prisma invocations have their own env-supply path
// (.env / CI inline / ECS sh wrapper).

import { composeDatabaseUrl } from '../db/compose-database-url.js'
import type { Config } from '../../config/schema.js'

export interface PrismaClientOptions {
  datasourceUrl: string
}

export function buildPrismaClientOptions(config: Config): PrismaClientOptions {
  return {
    datasourceUrl: composeDatabaseUrl(config),
  }
}
