// Production entrypoint — loads config, builds the app, listens, and
// wires graceful shutdown per spec 014 §5.

import { buildApp } from './app.js'
import { loadConfig } from './config/load.js'

const SHUTDOWN_DRAIN_GRACE_MS = 2_000
const FORCE_EXIT_MS = 28_000

async function main(): Promise<void> {
  const config = loadConfig()
  const app = await buildApp(config)

  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, 'shutdown initiated (spec 014 §5)')

    // TODO spec 011: flip readiness gate -> false here so /health/ready
    // returns 503 during the drain grace window below.

    setTimeout(() => {
      app.close().then(
        () => {
          app.log.info('shutdown complete')
          process.exit(0)
        },
        (err: unknown) => {
          app.log.error({ err }, 'shutdown failed')
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
  } catch (err) {
    app.log.error({ err }, 'startup failed')
    process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error('fatal: bootstrap failed before logger was ready', err)
  process.exit(1)
})
