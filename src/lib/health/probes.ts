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

/**
 * Contract for any value passing through {@link memoizeProbe}. The `status`
 * discriminator drives the cache policy: only `'ok'` results cache (see the
 * function's docs for rationale).
 */
export interface ProbeStatus {
  status: 'ok' | 'fail'
}

export interface ComponentResult extends ProbeStatus {
  /** Wall time spent on the probe, regardless of outcome. */
  latencyMs: number
  /** Optional internal error message — NEVER echoed in the readiness body. */
  error?: string
}

export type ComponentResults = Record<ComponentName, ComponentResult>

// ── Liveness ──────────────────────────────────────────────────────────────

export interface BuildInfo {
  gitSha: string
  timestamp: string
  version: string
}

export interface LivenessBody {
  status: 'alive'
  build: BuildInfo
}

/**
 * Spec 014 §4.2 — the three image-build identifiers are injected at
 * `docker build` time and surfaced here so ops can verify which commit /
 * tag a running pod is on without shelling in or reading deploy logs.
 *
 * Defaults to `'unknown'` when an env var is missing — covers `npm run dev`
 * locally and any test that boots the app without docker-build metadata.
 */
export function buildBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  return {
    gitSha: env.BUILD_GIT_SHA ?? 'unknown',
    timestamp: env.BUILD_TIMESTAMP ?? 'unknown',
    version: env.BUILD_VERSION ?? 'unknown',
  }
}

/**
 * Spec 011 §4.1 — liveness body.
 *
 * The `build` block was added per spec 014 §4.2 so the response doubles as
 * "what's running here?" introspection.
 */
export function buildLivenessBody(build: BuildInfo = buildBuildInfo()): LivenessBody {
  return { status: 'alive', build }
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

// ── Probe memoiser ────────────────────────────────────────────────────────

/**
 * Spec 011 §7.2 / spec 018 §10.2.1 — coalesce concurrent probe calls and
 * cache the resolved value for `ttlMs`.
 *
 * Cache policy — **only `status === 'ok'` results cache**. A failure result
 * (returned `{status: 'fail'}` OR thrown) is NOT cached, so a transient
 * hiccup re-probes on the very next call rather than pinning readiness to
 * fail for a full TTL window. K8s readiness polling is in the 1–10s range;
 * during a real outage a per-call re-probe is bounded (`SELECT 1` / `PING` /
 * `HeadBucket` are each trivially cheap).
 *
 * Generic constraint `T extends ProbeStatus` keeps the cache contract
 * explicit at call sites — adding a new probe forces the author to think
 * about ok / fail semantics rather than receiving silent caching.
 */
export function memoizeProbe<T extends ProbeStatus>(
  fn: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): () => Promise<T> {
  let expiresAt = 0
  let inflight: Promise<T> | undefined
  let value: T | undefined
  return async () => {
    const ts = now()
    if (value !== undefined && value.status === 'ok' && ts < expiresAt) {
      return value
    }
    if (inflight !== undefined) return inflight
    inflight = (async () => {
      try {
        const v = await fn()
        value = v
        if (v.status === 'ok') {
          expiresAt = now() + ttlMs
        }
        return v
      } finally {
        inflight = undefined
      }
    })()
    return inflight
  }
}
