// Spec 013 §6.1 — truncate all public tables (except _prisma_migrations)
// with RESTART IDENTITY CASCADE for test isolation.
//
// Stub: throws until Prisma client is wired (spec 003 §4) — needs a
// PrismaClient parameter once it exists.

export function truncateAll(): Promise<void> {
  return Promise.reject(
    new Error('tests/helpers/db.ts not implemented — see spec 013 §6.1 for the truncate query'),
  )
}
