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

// ── Overall diagnostic (spec 011 §4.4) ────────────────────────────────────

export type OverallStatus = 'ok' | 'degraded' | 'down'

export interface OverallComponent {
  status: 'ok' | 'fail'
  latencyMs: number
}

export interface OverallBody {
  status: OverallStatus
  /** Short git SHA — see spec §14.2: we expose this but NOT process / OS info. */
  version: string
  uptimeSec: number
  components: Record<ComponentName, OverallComponent>
  startupCompleted: boolean
  shuttingDown: boolean
}

export interface OverallInput {
  startupCompleted: boolean
  shuttingDown: boolean
  uptimeSec: number
  components: ComponentResults
  build: BuildInfo
}

export interface OverallOutput {
  httpStatus: 200 | 503
  body: OverallBody
}

/**
 * Spec 011 §4.4 — aggregate everything ops cares about into one human-
 * readable JSON. `degraded` is reserved for future non-critical dependencies
 * (spec §6.3); today we only have critical deps so it's `ok` or `down`.
 *
 * Shutdown is treated as `down` for the /health response — the pod is being
 * cordoned, callers should redirect. (Readiness already emits `draining`
 * via §4.2, but the overall view simplifies to up/down for humans.)
 */
export function buildOverallBody(input: OverallInput): OverallOutput {
  const componentsRedacted: Record<ComponentName, OverallComponent> = {
    db: { status: input.components.db.status, latencyMs: input.components.db.latencyMs },
    cache: { status: input.components.cache.status, latencyMs: input.components.cache.latencyMs },
  }
  const anyFail = Object.values(componentsRedacted).some((c) => c.status === 'fail')
  const status: OverallStatus = input.shuttingDown || anyFail ? 'down' : 'ok'
  const httpStatus: 200 | 503 = status === 'down' ? 503 : 200
  return {
    httpStatus,
    body: {
      status,
      version: input.build.gitSha,
      uptimeSec: input.uptimeSec,
      components: componentsRedacted,
      startupCompleted: input.startupCompleted,
      shuttingDown: input.shuttingDown,
    },
  }
}

// ── Single-component diagnostic (spec 011 §4.5) ───────────────────────────

export interface ComponentBody {
  status: 'ok' | 'down'
  latencyMs: number
  details: { ping: 'OK' } | { error: string }
}

export interface ComponentOutput {
  httpStatus: 200 | 503
  body: ComponentBody
}

/**
 * Spec 011 §4.5 — single-component diagnostic for ops debug. The raw probe
 * `error` is run through {@link categorizeProbeError} to produce a canonical
 * bucket (e.g. `connection_timeout`) — never echo the raw string, which
 * could carry connection strings, SQL fragments, or Redis keys (§14.2).
 */
export function buildComponentBody(component: ComponentResult): ComponentOutput {
  if (component.status === 'ok') {
    return {
      httpStatus: 200,
      body: { status: 'ok', latencyMs: component.latencyMs, details: { ping: 'OK' } },
    }
  }
  return {
    httpStatus: 503,
    body: {
      status: 'down',
      latencyMs: component.latencyMs,
      details: { error: categorizeProbeError(component.error) },
    },
  }
}

/**
 * Spec 011 §14.2 — map any raw probe error string to one of a small set of
 * canonical buckets. Keeps the wire response stable and prevents leaking
 * connection strings / SQL / Redis keys (anything outside the bucket label
 * itself is dropped).
 *
 * Buckets are matched in priority order; first match wins. Add a bucket
 * only when there's an operational reason to distinguish it (i.e. ops
 * would react differently). When in doubt, fall back to `unknown`.
 */
export function categorizeProbeError(raw: string | undefined): string {
  if (!raw) return 'unknown'
  const s = raw.toLowerCase()
  if (s.includes('timeout') || s.includes('etimedout')) return 'connection_timeout'
  if (s.includes('econnrefused') || s.includes('connection refused')) return 'connection_refused'
  if (s.includes('enotfound') || s.includes('eai_again')) return 'dns_failure'
  if (s.includes('authentication failed') || s.includes('sasl')) return 'auth_failed'
  return 'unknown'
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
