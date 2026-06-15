// Spec 021 §7.7 / spec 022 §4.0 — Clock injection seam.
//
// Every domain function that needs "now" (next-charge-at calculation,
// lifecycle `whereLive`, order paidAt / cancelledAt stamps, etc.) takes
// a `Clock` rather than calling `new Date()` directly. This is what makes
// the calculation deterministic under `vi.useFakeTimers` and what lets us
// pass a fixed `Date` to per-test scenarios without monkey-patching globals.
//
// Production wires `systemClock` once at boot (Fastify decorator
// `app.decorate('clock', systemClock)`); route handlers pull it via
// `req.server.clock` and forward to services as `deps.clock`.
//
// Tests build whatever clock they need:
//   const fixed: Clock = () => new Date('2026-06-15T08:00:00Z')

export type Clock = () => Date

export const systemClock: Clock = () => new Date()
