// Spec 013 §5 — globalSetup runs once per project before tests.
// Real implementation should start Postgres + Redis testcontainers via
// tests/helpers/container.ts, inject env vars (spec 001 §4.3), and run
// `prisma migrate deploy`. Returns teardown to stop containers.
//
// Stub: no-op. Triggered only if the project has matching test files,
// so empty integration/e2e dirs incur zero cost.
export default async function setup(): Promise<void> {
  // No-op until first integration/e2e test lands.
}
