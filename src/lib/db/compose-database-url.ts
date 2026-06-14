// Single canonical Postgres connection-string builder.
//
// DB_* are the authoritative inputs (spec 001 §3.2); this helper is the one
// place that turns them into the URL Prisma demands. Application code calls
// it via src/lib/prisma/options.ts; the seed script calls it directly.
//
// Prisma CLI invocations (local `npm run prisma:*`, CI `prisma migrate deploy`,
// the one-shot ECS migration task per ADR 010) read `env("DATABASE_URL")`
// from schema.prisma directly — they don't go through this helper. Those
// boundaries get the URL via .env / inline CI env / a shell wrapper.
//
// Password is percent-encoded so `@`, `:`, `/`, `?`, `#` in the secret don't
// corrupt the URL. User and schema are encoded for the same reason.

export interface DbConfigSlice {
  DB_USER: string
  DB_PASSWORD: string
  DB_HOST: string
  DB_PORT: number
  DB_NAME: string
  DB_SCHEMA: string
}

export function composeDatabaseUrl(config: DbConfigSlice): string {
  const user = encodeURIComponent(config.DB_USER)
  const password = encodeURIComponent(config.DB_PASSWORD)
  const schema = encodeURIComponent(config.DB_SCHEMA)
  return `postgresql://${user}:${password}@${config.DB_HOST}:${config.DB_PORT}/${config.DB_NAME}?schema=${schema}`
}
