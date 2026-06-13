// Spec 011 §9 — Readiness gate state machine.
//
// The gate is the in-process flag that the SIGTERM handler (src/server.ts)
// flips to drain traffic before app.close(). The startup flag flips on once
// during plugin registration; both are read by the /health/ready and
// /health/startup probes.

import { describe, expect, it, vi } from 'vitest'

import { createReadinessGate } from './gate.js'

describe('createReadinessGate (spec 011 §9.2)', () => {
  it('starts not-shutting-down and not-started', () => {
    const gate = createReadinessGate()
    expect(gate.isShuttingDown()).toBe(false)
    expect(gate.isStarted()).toBe(false)
  })

  it('markStarted() flips startup flag permanently to true (spec 011 §9.2)', () => {
    const gate = createReadinessGate()
    gate.markStarted()
    expect(gate.isStarted()).toBe(true)
    // Idempotent — second call does not regress.
    gate.markStarted()
    expect(gate.isStarted()).toBe(true)
  })

  it('shutDown() flips shutdown flag to true (spec 011 §9.1)', () => {
    const gate = createReadinessGate()
    gate.shutDown()
    expect(gate.isShuttingDown()).toBe(true)
  })

  it('shutDown() is idempotent — repeated calls stay down (spec 011 §9.2)', () => {
    const gate = createReadinessGate()
    gate.shutDown()
    gate.shutDown()
    expect(gate.isShuttingDown()).toBe(true)
  })

  it('shutDown() does not reset the startup flag (drain happens AFTER startup)', () => {
    const gate = createReadinessGate()
    gate.markStarted()
    gate.shutDown()
    expect(gate.isStarted()).toBe(true)
    expect(gate.isShuttingDown()).toBe(true)
  })

  it('uptimeSec() grows monotonically from creation time (spec 011 §4.4)', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-06-13T00:00:00Z'))
      const gate = createReadinessGate()
      expect(gate.uptimeSec()).toBe(0)
      vi.setSystemTime(new Date('2026-06-13T00:00:42Z'))
      expect(gate.uptimeSec()).toBe(42)
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits onShutdown listener exactly once even when shutDown() is called repeatedly', () => {
    const gate = createReadinessGate()
    const listener = vi.fn()
    gate.onShutdown(listener)
    gate.shutDown()
    gate.shutDown()
    gate.shutDown()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('emits onStarted listener exactly once even when markStarted() is called repeatedly', () => {
    const gate = createReadinessGate()
    const listener = vi.fn()
    gate.onStarted(listener)
    gate.markStarted()
    gate.markStarted()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
