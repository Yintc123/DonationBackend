// Spec 011 §3 / §9 — Fastify plugin wiring the three K8s probes.
//
// Responsibilities:
//   - Decorate `app.readinessGate` so `src/server.ts`'s SIGTERM handler can
//     call `app.readinessGate.shutDown()` to begin the drain (spec 011 §9.1).
//   - Register GET /health/{live,ready,startup,storage} — this plugin owns
//     the entire `/health/*` URL prefix so monitoring teams have a single
//     stop for every probe surface. Per-domain plugins (s3Plugin etc.) only
//     expose a `*HealthProbe` decorator; we register the route here.
//   - Wire the gate transitions to a child logger tagged `module: 'health'`
//     so K8s polling does NOT spam the log — only the 0→1 transitions emit
//     a log line (spec 011 §11.3 — request/response autolog is excluded for
//     `/health/*` by the spec-004 logger; here we only log state changes).
//   - Mark the gate `started` on Fastify `onReady` (spec 011 §4.3 / §9.2).
//
// Dependencies (must be registered before this plugin in src/app.ts):
//   - `app.prisma`         — spec 003 (DB probe runs `$queryRaw\`SELECT 1\``)
//   - `app.redis`          — spec 006 (cache probe runs PING)
//   - `app.s3HealthProbe`  — spec 018 (storage probe runs HeadBucket); the
//     decorator is OPTIONAL — if absent, /health/storage is simply not
//     registered, so this plugin can run in a no-S3 deployment.

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

import { createReadinessGate, type ReadinessGate } from './gate.js'
import {
  aggregateReadiness,
  buildLivenessBody,
  buildStartupBody,
  memoizeProbe,
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
const DB_TIMEOUT_MS = 500
const CACHE_TIMEOUT_MS = 200
// Spec 011 §7.2 — coalesce probes within a short window so K8s polling
// (typically 5s × multiple probes × multiple components) does not become
// a constant SELECT 1 / PING load on the backing stores. A 1000 ms TTL is
// short enough that a real outage propagates inside one K8s poll cycle.
const PROBE_CACHE_TTL_MS = 1_000

async function probeDb(app: FastifyInstance): Promise<ComponentResult> {
  const start = Date.now()
  try {
    await runWithTimeout(() => app.prisma.$queryRaw`SELECT 1`, DB_TIMEOUT_MS, 'db')
    return { status: 'ok', latencyMs: Date.now() - start }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'fail', latencyMs: Date.now() - start, error: message }
  }
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

  // Spec 011 §7.2 — each probe is memoized for PROBE_CACHE_TTL_MS so the
  // cluster's polling load on Postgres/Redis stays bounded. memoizeProbe
  // caches success only — a transient failure re-probes on the next call
  // (see lib/health/probes.ts for the contract).
  const cachedProbeDb = memoizeProbe(() => probeDb(app), PROBE_CACHE_TTL_MS)
  const cachedProbeCache = memoizeProbe(() => probeCache(app), PROBE_CACHE_TTL_MS)

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
    const [db, cache] = await Promise.all([cachedProbeDb(), cachedProbeCache()])
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

  // Spec 018 §10 — storage diagnostic, decoupled from readiness so a
  // transient S3 outage does NOT cordon the pod (list / detail endpoints
  // still serve; image <img src> load failures are a client concern).
  // We only register if s3Plugin is present; if not we silently skip so
  // this plugin remains useful in no-S3 deployments / unit-style tests.
  if (app.hasDecorator('s3HealthProbe')) {
    const storageLog = app.log.child({ module: 'storage' })
    app.get(
      '/health/storage',
      { config: { rateLimit: false } },
      async (_req, reply) => {
        const r = await app.s3HealthProbe()
        if (r.status === 'ok') {
          return reply.code(200).send({ status: 'ok', bucket: app.s3Config.bucket })
        }
        // Spec 018 §10.2 / §14.2 — never echo raw SDK / network detail to
        // clients; that's for the log only.
        storageLog.warn(
          { event: 'storage_health_failed', latencyMs: r.latencyMs, error: r.error },
          'storage probe failed',
        )
        return reply.code(503).send({ status: 'unhealthy', reason: 'S3 unreachable' })
      },
    )
  }
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
