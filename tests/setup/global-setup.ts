// Spec 013 §5 — globalSetup runs once per project before any test file.
//
// Spec 006 scope: start the Redis testcontainer and inject REDIS_URL so the
// per-test buildApp() picks up the live container. Postgres lifecycle is left
// out of scope.

import { startContainers, type TestContainers } from '../helpers/container.js'

let containers: TestContainers | undefined

export default async function setup(): Promise<() => Promise<void>> {
  containers = await startContainers()
  process.env.REDIS_URL = containers.redis.url

  return async () => {
    await containers?.stop()
    containers = undefined
  }
}
