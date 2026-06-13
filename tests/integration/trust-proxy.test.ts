// Spec 012 §6 — verifies that buildApp() wires Fastify trustProxy from
// RATE_LIMIT_TRUSTED_PROXIES so request.ip resolves from X-Forwarded-For
// when (and only when) the peer is in the allowlist.

import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../helpers/app.js'

describe('Fastify trustProxy wiring (spec 012 §6)', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('without RATE_LIMIT_TRUSTED_PROXIES, X-Forwarded-For is ignored (spec §6.1 dev default)', async () => {
    app = await buildApp({ RATE_LIMIT_TRUSTED_PROXIES: '' })
    app.get('/__ip', (req) => ({ ip: req.ip }))
    const res = await app.inject({
      method: 'GET',
      url: '/__ip',
      headers: { 'x-forwarded-for': '203.0.113.99' },
    })
    expect(res.json()).toEqual({ ip: '127.0.0.1' })
  })

  it('with allowlisted peer, X-Forwarded-For becomes request.ip (spec §6.3)', async () => {
    app = await buildApp({ RATE_LIMIT_TRUSTED_PROXIES: '127.0.0.1/32' })
    app.get('/__ip', (req) => ({ ip: req.ip }))
    const res = await app.inject({
      method: 'GET',
      url: '/__ip',
      headers: { 'x-forwarded-for': '203.0.113.99' },
    })
    expect(res.json()).toEqual({ ip: '203.0.113.99' })
  })

  it('rejects wildcard configuration at boot (spec §6.2)', async () => {
    await expect(buildApp({ RATE_LIMIT_TRUSTED_PROXIES: '*' })).rejects.toThrow(
      /must not be "\*"|wildcard/i,
    )
  })
})
