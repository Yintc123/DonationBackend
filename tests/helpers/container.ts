// Spec 013 §5 — PostgreSQL 16 + Redis 7 testcontainers helper.
//
// Real implementation:
//   - new PostgreSqlContainer('postgres:16').start()
//   - new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
//   - inject DB_HOST / DB_PORT / ... / REDIS_URL into process.env (spec 001)
//   - compose DATABASE_URL
//   - execSync('npx prisma migrate deploy')
//
// Stub: throws if called. First integration test will replace this.

export interface TestContainers {
  postgres: { connectionUri: string }
  redis: { url: string }
  stop: () => Promise<void>
}

export function startContainers(): Promise<TestContainers> {
  return Promise.reject(
    new Error(
      'tests/helpers/container.ts not implemented — see spec 013 §5 for lifecycle and §5.4 Docker prerequisite',
    ),
  )
}
