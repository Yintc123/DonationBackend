// Spec 013 §6.1 — per-test reset hooks.
//
// Implemented:
//   - FLUSHDB the test Redis instance (spec 006 §14.2)
//
// Pending (separate specs):
//   - truncate Postgres tables (spec 003 + spec 013 §6.1)
//   - msw.resetHandlers()
//   - vi.useRealTimers()

import { Redis } from 'ioredis'
import { beforeEach } from 'vitest'

beforeEach(async () => {
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) return // global-setup didn't run (e.g. unit project) — skip

  const client = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
  try {
    await client.connect()
    await client.flushdb()
  } finally {
    await client.quit()
  }
})
