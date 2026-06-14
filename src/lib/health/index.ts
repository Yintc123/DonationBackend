// Spec 011 — public surface of the health-check module.
//
// Consumers import:
//   - `healthPlugin`           — register on the Fastify app (spec 011 §3)
//   - `createReadinessGate`    — only needed if a non-Fastify caller wants its
//                                own gate; the plugin decorates app.readinessGate.
//   - the type-only re-exports keep callers strict-typed without reaching
//     into internal modules.

export { healthPlugin } from './plugin.js'
export { createReadinessGate, type ReadinessGate } from './gate.js'
export {
  aggregateReadiness,
  buildBuildInfo,
  buildLivenessBody,
  buildStartupBody,
  memoizeProbe,
  runWithTimeout,
  type BuildInfo,
  type ComponentName,
  type ComponentResult,
  type ComponentResults,
  type LivenessBody,
  type ProbeStatus,
} from './probes.js'
