// Spec 011 §4 / §5 — Probe response builders + timeout helper.
//
// Pure functions only. Side-effect-free aggregation of dependency-probe
// results into the wire shapes specified in §4. Keeping these pure makes the
// state machine easy to unit-test and reuse if we later add `/health/db` and
// `/health/cache` diagnostic endpoints (spec 011 §4.5).
//
// Output redaction rule (spec 011 §4.2 / §14.2):
//   - Readiness body MUST NOT expose raw error messages, connection strings,
//     SQL, Redis keys, etc. We only echo `"ok"` | `"fail"` per component.
//   - The detailed `error` field on `ComponentResult` is for INTERNAL logging
//     by the plugin (with module=health), not the response body.

export type ComponentName = 'db' | 'cache'

export interface ComponentResult {
  status: 'ok' | 'fail'
  /** Wall time spent on the probe, regardless of outcome. */
  latencyMs: number
  /** Optional internal error message — NEVER echoed in the readiness body. */
  error?: string
}

export type ComponentResults = Record<ComponentName, ComponentResult>

// ── Liveness ──────────────────────────────────────────────────────────────

export interface LivenessBody {
  status: 'alive'
}

/** Spec 011 §4.1 — liveness body. Constant; no inputs. */
export function buildLivenessBody(): LivenessBody {
  return { status: 'alive' }
}

// ── Readiness ─────────────────────────────────────────────────────────────

export interface ReadinessReadyBody {
  status: 'ready'
  components: Record<ComponentName, 'ok' | 'fail'>
}

export interface ReadinessNotReadyBody {
  status: 'not_ready'
  components: Record<ComponentName, 'ok' | 'fail'>
}

export interface ReadinessDrainingBody {
  status: 'draining'
  uptimeSec: number
}

export type ReadinessBody = ReadinessReadyBody | ReadinessNotReadyBody | ReadinessDrainingBody

export interface ReadinessInput {
  shuttingDown: boolean
  components: ComponentResults
  uptimeSec?: number
}

export interface ReadinessOutput {
  httpStatus: 200 | 503
  body: ReadinessBody
}

export function aggregateReadiness(input: ReadinessInput): ReadinessOutput {
  // Spec 011 §9.3 — draining overrides everything (we are shutting down,
  // so even if every component pings OK we want LB to remove us).
  if (input.shuttingDown) {
    return {
      httpStatus: 503,
      body: { status: 'draining', uptimeSec: input.uptimeSec ?? 0 },
    }
  }

  const componentSummary: Record<ComponentName, 'ok' | 'fail'> = {
    db: input.components.db.status,
    cache: input.components.cache.status,
  }
  const anyFail = Object.values(componentSummary).some((s) => s === 'fail')
  if (anyFail) {
    return {
      httpStatus: 503,
      body: { status: 'not_ready', components: componentSummary },
    }
  }
  return {
    httpStatus: 200,
    body: { status: 'ready', components: componentSummary },
  }
}

// ── Startup ───────────────────────────────────────────────────────────────

export interface StartupStartedBody {
  status: 'started'
}

export interface StartupStartingBody {
  status: 'starting'
  elapsedMs: number
}

export type StartupBody = StartupStartedBody | StartupStartingBody

export interface StartupInput {
  started: boolean
  uptimeSec: number
}

export interface StartupOutput {
  httpStatus: 200 | 503
  body: StartupBody
}

/** Spec 011 §4.3 — startup probe body. */
export function buildStartupBody(input: StartupInput): StartupOutput {
  if (input.started) {
    return { httpStatus: 200, body: { status: 'started' } }
  }
  return {
    httpStatus: 503,
    body: { status: 'starting', elapsedMs: input.uptimeSec * 1000 },
  }
}

// ── Timeout helper ────────────────────────────────────────────────────────

/**
 * Spec 011 §7.1 — wrap a dependency probe in a per-check timeout.
 * The tag is included in the timeout error message so the caller's log
 * pinpoints which dependency tripped.
 */
export async function runWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  tag: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timeout: ${tag} exceeded ${timeoutMs.toString()}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
