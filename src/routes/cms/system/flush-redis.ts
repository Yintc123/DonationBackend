// Spec 025 §3.1 — POST /cms/system/flush-redis.
//
// Emergency button: wipes the current Redis logical DB (FLUSHDB).
//
// IMPORTANT — this clears ALL of:
//   - cache entries (spec 019)
//   - rate-limit counters (spec 010) ← all per-user / per-IP budgets reset
//   - any future idempotency keys / sessions
//
// If the Redis instance is shared with other apps (different keyPrefix),
// FLUSHDB still clears EVERYTHING because keyPrefix is client-side filtering
// only. Spec 025 §4.2 assumes the instance is dedicated to this backend.
//
// The /cms scope-level `requireAdmin` preHandler (app.ts) already enforced
// admin role before this handler runs. Body schema requires literal
// `confirm: "FLUSH_ALL_REDIS_DATA"` to act as a typo-guard.

import type { FastifyInstance } from 'fastify'
import { Type, type Static } from '@sinclair/typebox'

const FlushRedisBody = Type.Object(
  {
    // Literal — wrong value or omission → 400 VALIDATION_FAILED at schema layer.
    confirm: Type.Literal('FLUSH_ALL_REDIS_DATA'),
  },
  { additionalProperties: false },
)
type FlushRedisBodyT = Static<typeof FlushRedisBody>

const FlushRedisResponse = Type.Object({
  flushedKeyCount: Type.Integer({ minimum: 0 }),
  durationMs: Type.Integer({ minimum: 0 }),
})

// Spec 025 §3.1.2 — deliberately low. Real ops use is rare; hot calls
// signal a runaway script or panic-loop and should be throttled.
//
// Two-layer budget:
//   - purpose (per-user): 6/h — caps a single operator
//   - perIp:              12/h — caps a NAT'd office sharing one egress IP
// (perUser would also fit here, but per-user authentication is admin-only
//  and the purpose layer is more semantically precise for "this action".)
const HOUR_MS = 60 * 60 * 1000
const FLUSH_REDIS_PURPOSE = {
  name: 'system-flush-redis',
  limit: 6,
  windowMs: HOUR_MS,
}
const FLUSH_REDIS_PER_IP = { limit: 12, windowMs: HOUR_MS }

export async function registerFlushRedisRoute(app: FastifyInstance): Promise<void> {
  app.route<{ Body: FlushRedisBodyT }>({
    method: 'POST',
    url: '/system/flush-redis',
    schema: {
      body: FlushRedisBody,
      response: { 200: FlushRedisResponse },
    },
    config: { rateLimit: { perIp: FLUSH_REDIS_PER_IP, purposes: [FLUSH_REDIS_PURPOSE] } },
    handler: async (req, reply) => {
      const accountId = req.user!.sub

      const before = await app.redis.dbsize()
      const startedAt = process.hrtime.bigint()
      await app.redis.flushdb()
      const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n)

      // Spec 025 §3.1.3 — warn-level audit, destructive.
      req.log.warn({
        event: 'system_redis_flushed',
        accountId,
        flushedKeyCount: before,
        durationMs,
        audit: true,
      })

      return reply.ok({ flushedKeyCount: before, durationMs })
    },
  })
}
