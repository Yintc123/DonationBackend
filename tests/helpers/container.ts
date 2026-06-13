// Spec 013 §5 — testcontainers helper.
//
// Implemented tiers:
//   - Redis:    new GenericContainer('redis:7-alpine').withExposedPorts(6379)
//
// Stubbed (out of scope of spec 006 task):
//   - Postgres: returns a sentinel error if a caller actually tries to use it.
//
// Lifecycle is owned by tests/setup/global-setup.ts.

import { GenericContainer, type StartedTestContainer } from 'testcontainers'

export interface TestContainers {
  postgres: { connectionUri: string }
  redis: { url: string }
  stop: () => Promise<void>
}

const POSTGRES_NOT_IMPLEMENTED =
  'Postgres testcontainer is not wired yet — out of scope for spec 006'

export async function startContainers(): Promise<TestContainers> {
  const redisContainer: StartedTestContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start()

  const redisHost = redisContainer.getHost()
  const redisPort = redisContainer.getMappedPort(6379)
  const redisUrl = `redis://${redisHost}:${redisPort}`

  return {
    postgres: {
      get connectionUri(): string {
        throw new Error(POSTGRES_NOT_IMPLEMENTED)
      },
    } as { connectionUri: string },
    redis: { url: redisUrl },
    stop: async () => {
      await redisContainer.stop()
    },
  }
}
