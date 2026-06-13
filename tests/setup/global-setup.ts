// Spec 013 §5 — globalSetup runs once per project before any test file.
//
// Vitest globalSetup runs in the main thread; mutations to process.env
// are NOT visible to worker processes. We therefore pass the
// testcontainer connection info via TestProject.provide(), and
// tests/setup/per-test-setup.ts + tests/helpers/app.ts use inject().

import { execSync } from 'node:child_process'

import type { TestProject } from 'vitest/node'

import { startContainers, type TestContainers } from '../helpers/container.js'

let containers: TestContainers | undefined

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  containers = await startContainers()

  const { postgres, redis } = containers

  project.provide('TEST_DATABASE_URL', postgres.connectionUri)
  project.provide('TEST_REDIS_URL', redis.url)
  project.provide('TEST_DB_HOST', postgres.host)
  project.provide('TEST_DB_PORT', String(postgres.port))
  project.provide('TEST_DB_USER', postgres.user)
  project.provide('TEST_DB_PASSWORD', postgres.password)
  project.provide('TEST_DB_NAME', postgres.database)
  project.provide('TEST_DB_SCHEMA', 'public')

  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: postgres.connectionUri },
  })

  return async () => {
    await containers?.stop()
    containers = undefined
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    TEST_DATABASE_URL: string
    TEST_REDIS_URL: string
    TEST_DB_HOST: string
    TEST_DB_PORT: string
    TEST_DB_USER: string
    TEST_DB_PASSWORD: string
    TEST_DB_NAME: string
    TEST_DB_SCHEMA: string
  }
}
