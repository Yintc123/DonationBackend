// Spec 005 §9 — process-level handler registration.
//
// We can't unit-test the real `process.on('unhandledRejection', ...)` flow
// without forking a subprocess (would kill the test runner). Instead the
// registration helper accepts an injectable `processLike` so the tests can
// observe what handlers got attached and what they do.
//
// Surface under test:
//   - registerProcessHandlers(processLike, logger, shutdown) registers BOTH
//     handlers exactly once (idempotent on a second call).
//   - The unhandledRejection handler logs fatal and triggers `shutdown`.
//   - The uncaughtException handler logs fatal and triggers `exit(1)`
//     (state is corrupted — no graceful drain).
//
// Spec §9.4 also says tests MUST NOT register handlers on the real process
// — we never pass `process` here.

import { describe, expect, it, vi } from 'vitest'

import { registerProcessHandlers, type ProcessLike } from './process-handlers.js'

// Handlers carry mixed signatures (unhandledRejection has 2 args,
// uncaughtException has 1). We collect them as the loosest shape and
// cast on invocation in each test.
type AnyHandler = (...args: unknown[]) => void

function makeProcessLike(): ProcessLike & {
  handlers: Map<string, AnyHandler[]>
  exitCalls: number[]
} {
  const handlers = new Map<string, AnyHandler[]>()
  const exitCalls: number[] = []
  return {
    handlers,
    exitCalls,
    on(event: string, handler: AnyHandler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return this
    },
    listenerCount(event: string) {
      return handlers.get(event)?.length ?? 0
    },
    exit(code?: number) {
      exitCalls.push(code ?? 0)
    },
  } as ProcessLike & { handlers: Map<string, AnyHandler[]>; exitCalls: number[] }
}

function makeLogger() {
  return {
    fatal: vi.fn(),
  }
}

describe('registerProcessHandlers (spec 005 §9)', () => {
  it('registers both handlers when called the first time', () => {
    const proc = makeProcessLike()
    registerProcessHandlers({ process: proc, logger: makeLogger(), shutdown: vi.fn() })

    expect(proc.handlers.get('unhandledRejection')?.length).toBe(1)
    expect(proc.handlers.get('uncaughtException')?.length).toBe(1)
  })

  it('is idempotent — a second call adds nothing', () => {
    const proc = makeProcessLike()
    const deps = { process: proc, logger: makeLogger(), shutdown: vi.fn() }
    registerProcessHandlers(deps)
    registerProcessHandlers(deps)

    expect(proc.handlers.get('unhandledRejection')?.length).toBe(1)
    expect(proc.handlers.get('uncaughtException')?.length).toBe(1)
  })

  it('unhandledRejection logs fatal and calls shutdown (drain still possible)', () => {
    const proc = makeProcessLike()
    const logger = makeLogger()
    const shutdown = vi.fn()
    registerProcessHandlers({ process: proc, logger, shutdown })

    const handler = proc.handlers.get('unhandledRejection')?.[0]
    if (!handler) throw new Error('unhandledRejection handler not registered')
    const reason = new Error('boom')
    handler(reason, Promise.resolve())

    expect(logger.fatal).toHaveBeenCalledTimes(1)
    const call = logger.fatal.mock.calls[0]
    if (!call) throw new Error('logger.fatal not called')
    expect(call[0]).toMatchObject({ err: reason, event: 'unhandled_rejection' })
    expect(call[1]).toMatch(/unhandled/i)
    expect(shutdown).toHaveBeenCalledOnce()
    expect(proc.exitCalls).toEqual([])
  })

  it('uncaughtException logs fatal and exits(1) immediately (no drain)', () => {
    const proc = makeProcessLike()
    const logger = makeLogger()
    const shutdown = vi.fn()
    registerProcessHandlers({ process: proc, logger, shutdown })

    const handler = proc.handlers.get('uncaughtException')?.[0]
    if (!handler) throw new Error('uncaughtException handler not registered')
    const err = new Error('boom')
    handler(err)

    expect(logger.fatal).toHaveBeenCalledTimes(1)
    const call = logger.fatal.mock.calls[0]
    if (!call) throw new Error('logger.fatal not called')
    expect(call[0]).toMatchObject({ err, event: 'uncaught_exception' })
    expect(call[1]).toMatch(/uncaught/i)
    // State may be corrupted — must NOT attempt graceful drain.
    expect(shutdown).not.toHaveBeenCalled()
    expect(proc.exitCalls).toEqual([1])
  })

  it('a thrown error inside the unhandledRejection handler does not propagate', () => {
    const proc = makeProcessLike()
    const logger = makeLogger()
    logger.fatal.mockImplementation(() => {
      throw new Error('logger blew up')
    })
    const shutdown = vi.fn()
    registerProcessHandlers({ process: proc, logger, shutdown })

    const lastHandler = proc.handlers.get('unhandledRejection')?.[0]
    if (!lastHandler) throw new Error('unhandledRejection handler not registered')
    // Per spec §9.4 — handler MUST NOT re-throw (would trigger Node abort).
    expect(() => {
      lastHandler(new Error('boom'), Promise.resolve())
    }).not.toThrow()
  })
})
