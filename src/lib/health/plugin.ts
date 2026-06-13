// Spec 011 §3 / §9 — Fastify plugin wiring the three K8s probes.
//
// Responsibilities:
//   - Decorate `app.readinessGate` so `src/server.ts`'s SIGTERM handler can
//     call `app.readinessGate.shutDown()` to begin the drain (spec 011 §9.1).
//   - Register GET /health/{live,ready,startup} with the contract defined in
//     spec 011 §4.
//   - Wire the gate transitions to a child logger tagged `module: 'health'`
//     so K8s polling does NOT spam the log — only the 0→1 transitions emit
//     a log line (spec 011 §11.3 — request/response autolog is excluded for
//     `/health/*` by the spec-004 logger; here we only log state changes).
//   - Mark the gate `started` on Fastify `onReady` (spec 011 §4.3 / §9.2).
//
// DB probe choice — OPTION (A): stub.
//   Prisma (spec 003) is not wired yet — the Fastify instance does not have
//   `app.prisma`. Spec 011 §11.1 says the DB probe should run
//   `prisma.$queryRaw`SELECT 1``, but we cannot do that without the plugin.
//   Spec 011 §13 (test plan) lists "pause DB container" as integration
//   coverage owned by spec 003 once it ships.
//
//   We therefore:
//     - report db: "ok" with latency 0 for now,
//     - leave a clearly marked TODO so the spec-003 PR knows where to wire it.
//
//   Why not connect raw `pg`? It would couple this module to a second client
//   lifecycle, violating spec 003 §4 (single Prisma instance owns DB I/O).
//
// TODO(spec 003 §13 / spec 011 §11.1):
//   When the Prisma plugin lands and decorates `app.prisma`, replace
//   `probeDb` below with:
//     await runWithTimeout(
//       () => app.prisma.$queryRaw`SELECT 1`,
//       DB_TIMEOUT_MS, 'db',
//     )
//   Keep the timeout + ok/fail shape identical so this file's tests do not
//   change. See spec 011 §7.1 (timeouts) and §4.2 (response shape).

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { createReadinessGate, type ReadinessGate } from './gate.js'
import {
  aggregateReadiness,
  buildLivenessBody,
  buildStartupBody,
  runWithTimeout,
  type ComponentResult,
  type ComponentResults,
} from './probes.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** Spec 011 §9 — readiness gate (`src/server.ts` calls `.shutDown()`). */
    readinessGate: ReadinessGate
  }
}

// Spec 011 §7.1 — per-check timeouts.
//
// `_DB_TIMEOUT_MS` is exported as documentation for the spec-003 follow-up
// that will start using it once Prisma is wired (see file header TODO).
// Prefixed with `_` so lint allows the placeholder until then.
export const _DB_TIMEOUT_MS = 500
const CACHE_TIMEOUT_MS = 200

async function probeDb(_app: FastifyInstance): Promise<ComponentResult> {
  // STUB until spec 003 lands `app.prisma`. See file header TODO.
  return Promise.resolve({ status: 'ok', latencyMs: 0 })
}

async function probeCache(app: FastifyInstance): Promise<ComponentResult> {
  const start = Date.now()
  try {
    await runWithTimeout(() => app.redis.ping(), CACHE_TIMEOUT_MS, 'cache')
    return { status: 'ok', latencyMs: Date.now() - start }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'fail', latencyMs: Date.now() - start, error: message }
  }
}

const healthPluginAsync: FastifyPluginAsync = async (app: FastifyInstance) => {
  const gate = createReadinessGate()
  app.decorate('readinessGate', gate)

  // Spec 011 §11.3 — child logger tagged module=health. Only state
  // transitions emit log lines (no per-probe spam).
  const log = app.log.child({ module: 'health' })
  gate.onStarted(() => {
    log.info({ event: 'health_startup_completed' }, 'startup completed')
  })
  gate.onShutdown(() => {
    log.info({ event: 'health_shutdown_drain_started' }, 'readiness drain started')
  })

  // Spec 011 §4.3 / §9.2 — once Fastify has finished registering all plugins
  // and routes, mark the gate started. K8s startup probe flips green from
  // this point.
  app.addHook('onReady', async () => {
    gate.markStarted()
  })

  // ── routes ────────────────────────────────────────────────────────────

  // Spec 011 §4.1 — liveness: no dependency check at all.
  app.get('/health/live', async (_req, reply) => {
    return reply.code(200).send(buildLivenessBody())
  })

  // Spec 011 §4.2 — readiness: probe deps in parallel, gate overrides.
  app.get('/health/ready', async (_req, reply) => {
    // Even if a dep probe blows up, do not throw — readiness must always
    // return a structured 200/503 body (spec 011 §5.1).
    const [db, cache] = await Promise.all([probeDb(app), probeCache(app)])
    const components: ComponentResults = { db, cache }
    const out = aggregateReadiness({
      shuttingDown: gate.isShuttingDown(),
      components,
      uptimeSec: gate.uptimeSec(),
    })
    if (out.body.status !== 'ready' && out.body.status !== 'draining') {
      // Spec 011 §12.1 event dictionary — log dep failures (transition is
      // noisy across many polls, but a one-line warn per failure is the
      // ops signal); restrict to fail-state, not happy-path polls.
      log.warn(
        {
          event: 'health_check_failed',
          components: {
            db: db.status,
            cache: cache.status,
          },
        },
        'readiness probe failed',
      )
    }
    return reply.code(out.httpStatus).send(out.body)
  })

  // Spec 011 §4.3 — startup: in-process flag only.
  app.get('/health/startup', async (_req, reply) => {
    const out = buildStartupBody({
      started: gate.isStarted(),
      uptimeSec: gate.uptimeSec(),
    })
    return reply.code(out.httpStatus).send(out.body)
  })
}

export const healthPlugin = fp(healthPluginAsync, {
  name: 'health-plugin',
  fastify: '5.x',
  // Depends on the redis plugin (cache probe) and on errorHandler being
  // installed first so any unexpected throw inside a handler still emits a
  // sane response — but we don't enforce dependencies here because Fastify's
  // dependency graph is name-based and not all of those plugins use stable
  // names. The buildApp() registration order (errors → redis → health) is
  // the source of truth.
})
