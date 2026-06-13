// buildApp() factory — assembles the Fastify instance.
//
// Lifecycle:
//   1. Caller supplies a validated Config (see src/config/load.ts).
//   2. Construct Fastify with the spec-004 logger driven by config.
//   3. Decorate app.config so plugins (redis, security) can read it.
//   4. Register security plugins: helmet → cors (spec 012 §4 — helmet
//      first so its headers also stamp CORS preflight 204 responses).
//   5. Register HTTP response conventions (spec 009 — reply decorators,
//      X-Request-Id onSend hook).
//   6. Register Redis (spec 006) — eager connect, fail-fast.
//   7. Register health probe stubs (spec 011); real readiness gate
//      lands with spec 011 implementation.

import Fastify, { type FastifyInstance } from 'fastify'

import { errorHandlerPlugin } from './lib/errors/index.js'
import { createLogger } from './lib/logger/index.js'
import { redisPlugin } from './lib/redis/index.js'
import { corsPlugin, helmetPlugin } from './lib/security/index.js'
import { httpResponsePlugin } from './lib/http/index.js'
import type { Config } from './config/schema.js'

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
  }
}

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: createLogger(config) })

  app.decorate('config', config)

  // Error handler must be set BEFORE plugins that may throw, so its
  // setErrorHandler is in place by the time those plugins register hooks.
  await app.register(errorHandlerPlugin)

  await app.register(helmetPlugin)
  await app.register(corsPlugin)
  await app.register(httpResponsePlugin)
  await app.register(redisPlugin)

  // Health probes — stubs that always succeed. Real implementations
  // (readiness gate flip on SIGTERM, DB ping, etc.) land with spec 011.
  app.get('/health/live', () => ({ status: 'ok' }))
  app.get('/health/ready', () => ({ status: 'ok' }))
  app.get('/health/startup', () => ({ status: 'ok' }))

  return app
}
