import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../helpers/app.js'

describe('GET /health/*', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  it('/health/live returns 200 ok', async () => {
    app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/health/live' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('/health/ready returns 200 ok', async () => {
    app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('/health/startup returns 200 ok', async () => {
    app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/health/startup' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('startup fails when JWT secrets are identical', async () => {
    const dup = 'duplicated-secret-at-least-32-characters!'
    await expect(buildApp({ JWT_ACCESS_SECRET: dup, JWT_REFRESH_SECRET: dup })).rejects.toThrow(
      /must differ/,
    )
  })
})
