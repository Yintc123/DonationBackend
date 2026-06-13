// Spec 013 §6 + §8 — per-test reset hooks:
// - truncate all public tables (spec 013 §6.1)
// - FLUSHDB all Redis tier DBs (spec 013 §6.1)
// - msw.resetHandlers() (spec 013 §8.3)
// - vi.useRealTimers() to reset fake timers (spec 013 §8.1)
//
// Stub: no-op until helpers in tests/helpers/* are implemented.
import { beforeEach } from 'vitest'

beforeEach(() => {
  // No-op.
})
