// Production entrypoint — loads config, builds the app, listens, and
// wires graceful shutdown per spec 014 §5.
//
// Emits the four server-lifecycle events the spec 004 §9.3.1 dictionary
// owns:
//   startup_begin     → before buildApp()
//   startup_complete  → after listen, with a redacted config snapshot
//   shutdown_begin    → on SIGTERM / SIGINT
//   shutdown_complete → after app.close() drains successfully
//
// The startup snapshot intentionally re-emits the WHOLE Config object;
// pino's redact engine (spec 004 §7.1) replaces secrets with `[Redacted]`
// so the snapshot is safe to keep in an aggregator.

import { buildApp } from './app.js'
import { loadConfig } from './config/load.js'

const SHUTDOWN_DRAIN_GRACE_MS = 2_000
const FORCE_EXIT_MS = 28_000

async function main(): Promise<void> {
  const config = loadConfig()
  const app = await buildApp(config)

  app.log.info({ event: 'startup_begin' }, 'startup begin')

  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ event: 'shutdown_begin', signal }, 'shutdown initiated (spec 014 §5)')

    // Spec 011 §9 — flip readiness gate so /health/ready returns 503
    // immediately; K8s removes the pod from service while in-flight
    // requests finish during the drain grace window below.
    app.readinessGate.shutDown()

    setTimeout(() => {
      app.close().then(
        () => {
          app.log.info({ event: 'shutdown_complete' }, 'shutdown complete')
          process.exit(0)
        },
        (err: unknown) => {
          app.log.error({ event: 'shutdown_complete', err }, 'shutdown failed')
          process.exit(1)
        },
      )
    }, SHUTDOWN_DRAIN_GRACE_MS)

    // Force-exit safety net (spec 014 §5.3)
    setTimeout(() => {
      app.log.error('shutdown force-exit timeout exceeded')
      process.exit(1)
    }, FORCE_EXIT_MS).unref()
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  try {
    await app.listen({ port: config.PORT, host: config.HOST })
    // Spec 004 §11.1 — single startup snapshot with the (redacted) config.
    app.log.info(
      {
        event: 'startup_complete',
        config,
        listening: { port: config.PORT, host: config.HOST },
      },
      'startup complete',
    )
  } catch (err) {
    app.log.error({ err }, 'startup failed')
    process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error('fatal: bootstrap failed before logger was ready', err)
  process.exit(1)
})
