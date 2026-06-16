// Spec 005 §9 — process-level fatal handlers.
//
// Operational errors flow through Fastify's setErrorHandler (plugin.ts).
// Programmer errors that escape to Node's top level (unhandled promise
// rejection, uncaught exception) land here.
//
// Why this is a separate module from plugin.ts:
//   - Fastify lifecycle handles request errors; this layer handles process
//     lifecycle. Different concerns, different timing.
//   - We MUST NOT touch `process` from inside test runners (spec §9.4 —
//     installing real handlers would break vitest's own error handling).
//     Keeping the registration in its own module lets src/server.ts call
//     it explicitly at boot, while tests inject a `ProcessLike` stub.
//
// Idempotency: tests boot many Fastify instances per file; if the future
// `buildApp()` ever called this helper, we'd want a second call to be a
// no-op. We gate on listenerCount() to keep that contract.

export interface ProcessLike {
  on(event: 'unhandledRejection', handler: (reason: unknown, promise: Promise<unknown>) => void): unknown
  on(event: 'uncaughtException', handler: (err: Error) => void): unknown
  listenerCount(event: string): number
  exit(code?: number): void
}

export interface FatalLogger {
  fatal(meta: Record<string, unknown>, msg: string): void
}

export interface RegisterProcessHandlersDeps {
  process: ProcessLike
  logger: FatalLogger
  /** Called by the `unhandledRejection` handler. Best-effort drain — caller
   *  decides whether to invoke app.close() / process.exit() inside. */
  shutdown: () => void
}

/**
 * Spec 005 §9 — install process-level fatal handlers.
 *
 * Re-entry safety:
 *   - `unhandledRejection` ⇒ logger.fatal + shutdown (in-flight requests
 *     may still complete during graceful drain).
 *   - `uncaughtException`  ⇒ logger.fatal + exit(1) (state is corrupted;
 *     do NOT drain; supervisor will restart).
 *
 * Both handlers swallow any error their own bodies throw — re-throwing
 * inside a process-level handler aborts the Node runtime with no log.
 */
export function registerProcessHandlers(deps: RegisterProcessHandlersDeps): void {
  if (deps.process.listenerCount('unhandledRejection') === 0) {
    deps.process.on('unhandledRejection', (reason, promise) => {
      try {
        deps.logger.fatal(
          { event: 'unhandled_rejection', err: reason, promise },
          'unhandledRejection — process will drain',
        )
      } catch {
        // Logger failure cannot block the shutdown signal — silently
        // proceed (spec §9.4: handlers MUST NOT re-throw).
      }
      try {
        deps.shutdown()
      } catch {
        // Same rationale — shutdown failure is observed via the supervisor
        // (process won't exit cleanly), not by this handler re-throwing.
      }
    })
  }

  if (deps.process.listenerCount('uncaughtException') === 0) {
    deps.process.on('uncaughtException', (err) => {
      try {
        deps.logger.fatal(
          { event: 'uncaught_exception', err },
          'uncaughtException — process will exit',
        )
      } catch {
        // See above.
      }
      // Do NOT graceful-drain: process state may be corrupted, drain could
      // sit on a dead transaction forever. Exit and let the supervisor
      // restart.
      deps.process.exit(1)
    })
  }
}
