// Spec 011 §9 — Readiness gate state machine (in-process flags).
//
// Two orthogonal one-shot flags:
//   - `started`: false → true exactly once, when all plugin registration is
//     done (Fastify `onReady`). Reading after that is O(1).
//   - `shuttingDown`: false → true exactly once, when the process receives
//     SIGTERM/SIGINT. The readiness probe (spec 011 §4.2) immediately starts
//     returning 503 so K8s drops the pod from service.
//
// Listener callbacks (`onStarted`, `onShutdown`) fire ONCE on the transition,
// not on subsequent idempotent calls. This is what lets `plugin.ts` emit a
// transition-only log (spec 011 §13 / spec 004 §6.1 — no spam on every K8s
// poll).
//
// Why a factory instead of a global singleton:
//   - Multiple Fastify instances during testing each need their own gate.
//   - `app.decorate('readinessGate', gate)` makes the gate instance-scoped
//     while still letting `server.ts` reach it via `app.readinessGate`.

export interface ReadinessGate {
  /** Spec 011 §4.3 — true once all plugins have registered successfully. */
  isStarted(): boolean
  /** Spec 011 §9 — true once SIGTERM/SIGINT has been observed. */
  isShuttingDown(): boolean
  /** Spec 011 §9.2 — exposed for `onReady` hook to flip the startup flag. */
  markStarted(): void
  /** Spec 011 §9.1 — exposed for SIGTERM handler in `src/server.ts`. */
  shutDown(): void
  /** Spec 011 §4.4 — seconds since gate construction. */
  uptimeSec(): number
  /** Listener fired exactly once on the `started` 0→1 transition. */
  onStarted(listener: () => void): void
  /** Listener fired exactly once on the `shuttingDown` 0→1 transition. */
  onShutdown(listener: () => void): void
}

export function createReadinessGate(): ReadinessGate {
  const createdAtMs = Date.now()
  let started = false
  let shuttingDown = false
  const startedListeners: (() => void)[] = []
  const shutdownListeners: (() => void)[] = []

  const fire = (listeners: (() => void)[]): void => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // Listeners are best-effort. A throw here must not block the
        // transition (e.g. a log call failing mid-shutdown).
      }
    }
  }

  return {
    isStarted: () => started,
    isShuttingDown: () => shuttingDown,
    markStarted: () => {
      if (started) return
      started = true
      fire(startedListeners)
    },
    shutDown: () => {
      if (shuttingDown) return
      shuttingDown = true
      fire(shutdownListeners)
    },
    uptimeSec: () => Math.floor((Date.now() - createdAtMs) / 1000),
    onStarted: (listener) => {
      startedListeners.push(listener)
    },
    onShutdown: (listener) => {
      shutdownListeners.push(listener)
    },
  }
}
