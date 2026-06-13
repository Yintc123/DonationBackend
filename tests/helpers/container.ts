// Spec 013 §5 — testcontainers helper.
//
// Implemented tiers:
//   - Redis:    new GenericContainer('redis:7-alpine').withExposedPorts(6379)
//   - Postgres: PostgreSqlContainer('postgres:16-alpine')
//
// Lifecycle is owned by tests/setup/global-setup.ts.

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'

export interface PostgresInfo {
  connectionUri: string
  host: string
  port: number
  user: string
  password: string
  database: string
}

export interface TestContainers {
  postgres: PostgresInfo
  redis: { url: string }
  stop: () => Promise<void>
}

export async function startContainers(): Promise<TestContainers> {
  const [redisContainer, pgContainer] = await Promise.all([
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    new PostgreSqlContainer('postgres:16-alpine').start(),
  ])

  const redisInfo = buildRedisInfo(redisContainer)
  const postgresInfo = buildPostgresInfo(pgContainer)

  return {
    postgres: postgresInfo,
    redis: redisInfo,
    stop: async () => {
      await Promise.all([redisContainer.stop(), pgContainer.stop()])
    },
  }
}

function buildRedisInfo(c: StartedTestContainer): { url: string } {
  return { url: `redis://${c.getHost()}:${c.getMappedPort(6379).toString()}` }
}

function buildPostgresInfo(c: StartedPostgreSqlContainer): PostgresInfo {
  const host = c.getHost()
  const port = c.getMappedPort(5432)
  const user = c.getUsername()
  const password = c.getPassword()
  const database = c.getDatabase()
  return {
    host,
    port,
    user,
    password,
    database,
    connectionUri: `postgresql://${user}:${password}@${host}:${port.toString()}/${database}?schema=public`,
  }
}
