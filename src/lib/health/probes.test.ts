// Spec 011 §4 / §5 — Probe result aggregator (pure functions).

import { describe, expect, it } from 'vitest'

import {
  aggregateReadiness,
  buildLivenessBody,
  buildStartupBody,
  runWithTimeout,
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
