// Spec 004 §6.3 / spec 012 §6.5 — end-to-end X-Request-Id wiring.
//
// This pins the integration between Fastify's request.id, pino's log binding,
// and our http-response onSend hook. The motivating bug (pre v0.4): the
// response header echoed the validated inbound id, but the log binding
// (`reqId` at the time) showed Fastify's auto-generated `req-1` — so BFF
// and backend logs could not be joined on a shared id even when the value
// the BFF sent was perfectly valid.
//
// Fix: wire `genReqId` to `genRequestId(headers['x-request-id'])` so
// request.id IS the validated inbound (or a fresh UUID), and rename the
// pino binding to `requestId` via `requestIdLogLabel` so it matches the
// frontend's logging convention.

import { Writable } from 'node:stream'

import Fastify, { type FastifyInstance } from 'fastify'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import httpResponsePlugin from './plugin.js'
import { genRequestId, isValidRequestId } from './request-id.js'

function captureLogs() {
  const buf: string[] = []
  const dest = new Writable({
    write(chunk, _enc, cb) {
      buf.push(chunk.toString())
      cb()
    },
  })
  const logger = pino({ level: 'info' }, dest)
  const lines = (): Record<string, unknown>[] =>
    buf
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  return { logger, lines }
}

async function buildWiredApp(): Promise<{
  app: FastifyInstance
  lines: () => Record<string, unknown>[]
}> {
  const { logger, lines } = captureLogs()
  const app = Fastify({
    // Pino is structurally a FastifyBaseLogger at runtime, but pino's
    // heavily-generic types don't line up with Fastify's narrower contract
    // (childLoggerFactory generic mismatch). Test glue only — cast to any
    // so the wiring stays focused on genReqId / requestIdLogLabel.
    loggerInstance: logger as any,
    // The two options under test, mirrored from src/app.ts:
    requestIdLogLabel: 'requestId',
    genReqId: (req) => genRequestId(req.headers['x-request-id']),
  })
  await app.register(httpResponsePlugin)
  app.get('/r', async (request, reply) => {
    // Emit one info line under the request scope so the bound `requestId`
    // ends up on a real log entry we can assert against.
    request.log.info('handler')
    return reply.ok({ ok: true })
  })
  return { app, lines }
}

describe('X-Request-Id end-to-end wiring (spec 004 §6.3, spec 012 §6.5)', () => {
  let app: FastifyInstance | undefined
  let lines: (() => Record<string, unknown>[]) | undefined

  beforeEach(async () => {
    ;({ app, lines } = await buildWiredApp())
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    lines = undefined
  })

  it('binds log `requestId` to the SAME value as the response header for a valid inbound id', async () => {
    const inbound = 'req_2026-06-22_AbCd1234'

    const res = await app!.inject({
      method: 'GET',
      url: '/r',
      headers: { 'x-request-id': inbound },
    })

    expect(res.headers['x-request-id']).toBe(inbound)
    const handlerLine = lines!().find((l) => l.msg === 'handler')
    expect(handlerLine).toBeDefined()
    // The whole point: log binding key is `requestId` (not pino-default `reqId`)
    // AND its value matches what the response header echoes.
    expect(handlerLine).toMatchObject({ requestId: inbound })
    expect(handlerLine!.reqId).toBeUndefined()
  })

  it('uses a freshly generated id when inbound fails the safety check — header and log still agree', async () => {
    const res = await app!.inject({
      method: 'GET',
      url: '/r',
      // Injection attempt: contains \n, fails charset (spec 012 §6.5.2).
      headers: { 'x-request-id': 'evil\nadmin=1' },
    })

    const headerId = res.headers['x-request-id'] as string
    expect(headerId).not.toContain('\n')
    expect(isValidRequestId(headerId)).toBe(true)

    const handlerLine = lines!().find((l) => l.msg === 'handler')
    expect(handlerLine).toMatchObject({ requestId: headerId })
  })

  it('generates a fresh valid id when no inbound header is sent', async () => {
    const res = await app!.inject({ method: 'GET', url: '/r' })

    const headerId = res.headers['x-request-id'] as string
    expect(isValidRequestId(headerId)).toBe(true)

    const handlerLine = lines!().find((l) => l.msg === 'handler')
    expect(handlerLine).toMatchObject({ requestId: headerId })
  })
})
