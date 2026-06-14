// Spec 011 §4 / §5 — Probe result aggregator (pure functions).

import { describe, expect, it, vi } from 'vitest'

import {
  aggregateReadiness,
  buildLivenessBody,
  buildStartupBody,
  memoizeProbe,
  runWithTimeout,
  type ProbeStatus,
} from './probes.js'

describe('aggregateReadiness (spec 011 §4.2 / §5)', () => {
  it('all components ok + gate up → status=ready, http=200', () => {
    const out = aggregateReadiness({
      shuttingDown: false,
      components: { db: { status: 'ok', latencyMs: 1 }, cache: { status: 'ok', latencyMs: 1 } },
    })
    expect(out.httpStatus).toBe(200)
    expect(out.body.status).toBe('ready')
    if (out.body.status !== 'ready') throw new Error('narrow')
    expect(out.body.components).toEqual({ db: 'ok', cache: 'ok' })
  })

  it('shuttingDown=true → status=draining, http=503, no components key (spec 011 §9.3)', () => {
    const out = aggregateReadiness({
      shuttingDown: true,
      components: { db: { status: 'ok', latencyMs: 1 }, cache: { status: 'ok', latencyMs: 1 } },
      uptimeSec: 42,
    })
    expect(out.httpStatus).toBe(503)
    expect(out.body.status).toBe('draining')
    expect(out.body).not.toHaveProperty('components')
    expect(out.body).toMatchObject({ uptimeSec: 42 })
  })

  it('any component failed → status=not_ready, http=503, components show fail (spec 011 §4.2)', () => {
    const out = aggregateReadiness({
      shuttingDown: false,
      components: {
        db: { status: 'ok', latencyMs: 1 },
        cache: { status: 'fail', latencyMs: 200, error: 'connection_timeout' },
      },
    })
    expect(out.httpStatus).toBe(503)
    expect(out.body.status).toBe('not_ready')
    if (out.body.status !== 'not_ready') throw new Error('narrow')
    expect(out.body.components).toEqual({ db: 'ok', cache: 'fail' })
  })

  it('does not leak raw error details into the readiness body (spec 011 §4.2 / §14.2)', () => {
    const out = aggregateReadiness({
      shuttingDown: false,
      components: {
        db: {
          status: 'fail',
          latencyMs: 503,
          error: 'connection refused 10.0.0.5:5432 password=hunter2',
        },
        cache: { status: 'ok', latencyMs: 1 },
      },
    })
    // Body is purely { status: 'ok'|'fail' } per component (§4.2 example).
    const json = JSON.stringify(out.body)
    expect(json).not.toContain('hunter2')
    expect(json).not.toContain('10.0.0.5')
    expect(json).not.toContain('connection refused')
  })
})

describe('buildLivenessBody (spec 011 §4.1)', () => {
  it('returns the canonical alive body', () => {
    expect(buildLivenessBody()).toEqual({ status: 'alive' })
  })
})

describe('buildStartupBody (spec 011 §4.3)', () => {
  it('status=started when started=true', () => {
    const out = buildStartupBody({ started: true, uptimeSec: 5 })
    expect(out.httpStatus).toBe(200)
    expect(out.body).toEqual({ status: 'started' })
  })

  it('status=starting + elapsedMs when started=false (spec 011 §4.3)', () => {
    const out = buildStartupBody({ started: false, uptimeSec: 3 })
    expect(out.httpStatus).toBe(503)
    expect(out.body).toMatchObject({ status: 'starting' })
    expect(out.body).toHaveProperty('elapsedMs')
  })
})

describe('runWithTimeout (spec 011 §7.1)', () => {
  it('resolves the inner result on success', async () => {
    const r = await runWithTimeout(() => Promise.resolve('ok'), 100, 'tag')
    expect(r).toBe('ok')
  })

  it('rejects with a tagged timeout error when the inner op exceeds the budget', async () => {
    await expect(
      runWithTimeout(() => new Promise((res) => setTimeout(res, 500)), 20, 'redis'),
    ).rejects.toThrow(/timeout.*redis/i)
  })

  it('propagates the inner error verbatim (so caller can log the cause)', async () => {
    await expect(
      runWithTimeout(() => Promise.reject(new Error('boom')), 100, 'tag'),
    ).rejects.toThrow('boom')
  })
})

describe('memoizeProbe (spec 011 §7.2 / spec 018 §10.2.1)', () => {
  type Result = ProbeStatus & { tag: string }
  const ok = (tag: string): Result => ({ status: 'ok', tag })
  const fail = (tag: string): Result => ({ status: 'fail', tag })

  it('returns the underlying value on the first call', async () => {
    const fn = vi.fn().mockResolvedValue(ok('first'))
    const probe = memoizeProbe(fn, 1000)
    expect(await probe()).toEqual({ status: 'ok', tag: 'first' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent calls into a single underlying invocation', async () => {
    let resolveFn: ((v: Result) => void) | undefined
    const fn = vi.fn().mockImplementation(
      () =>
        new Promise<Result>((resolve) => {
          resolveFn = resolve
        }),
    )
    const probe = memoizeProbe(fn, 1000)
    const p1 = probe()
    const p2 = probe()
    const p3 = probe()
    // fn() ran synchronously inside the inflight async IIFE, so resolveFn is set.
    if (!resolveFn) throw new Error('resolveFn not captured — memoize broke its async contract')
    resolveFn(ok('shared'))
    await Promise.all([p1, p2, p3])
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('caches a successful result for ttlMs and re-probes after expiry', async () => {
    let nowMs = 1_000_000
    const fn = vi.fn().mockResolvedValue(ok('cached'))
    const probe = memoizeProbe(fn, 1000, () => nowMs)
    await probe()
    await probe()
    expect(fn).toHaveBeenCalledTimes(1)

    nowMs += 1100
    await probe()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does NOT cache a failure result — a transient hiccup re-probes immediately', async () => {
    let nowMs = 1_000_000
    const fn = vi
      .fn<() => Promise<Result>>()
      .mockResolvedValueOnce(fail('boom'))
      .mockResolvedValue(ok('recovered'))
    const probe = memoizeProbe(fn, 1000, () => nowMs)

    const r1 = await probe()
    expect(r1.status).toBe('fail')

    nowMs += 50
    const r2 = await probe()
    expect(r2.status).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does NOT cache a thrown error — next call retries fresh', async () => {
    let nowMs = 1_000_000
    const fn = vi
      .fn<() => Promise<Result>>()
      .mockRejectedValueOnce(new Error('network glitch'))
      .mockResolvedValue(ok('recovered'))
    const probe = memoizeProbe(fn, 1000, () => nowMs)

    await expect(probe()).rejects.toThrow('network glitch')

    nowMs += 10
    const r2 = await probe()
    expect(r2.status).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('clears the inflight slot even when the underlying call throws (no permanent inflight pin)', async () => {
    const fn = vi
      .fn<() => Promise<Result>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValue(ok('second'))
    const probe = memoizeProbe(fn, 1000)

    await expect(probe()).rejects.toThrow('first')
    // A second call MUST start a fresh probe (not get stuck on a dead inflight).
    const r = await probe()
    expect(r).toEqual({ status: 'ok', tag: 'second' })
  })
})
