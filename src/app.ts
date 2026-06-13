// buildApp() factory — assembles the Fastify instance.
//
// Plugin order (each line cites the spec that mandates the placement):
//   1. createLogger(config) → Fastify({ logger }) (spec 004 §3)
//   2. decorate app.config (consumed by all later plugins)
//   3. errorHandlerPlugin (spec 005) — setErrorHandler early so later
//      plugins' thrown errors are caught
//   4. helmetPlugin → corsPlugin (spec 012 §4 — helmet first so its
//      headers also stamp CORS preflight 204 responses)
//   5. httpResponsePlugin (spec 009) — reply decorators + X-Request-Id
//   6. redisPlugin (spec 006) — eager connect, fail-fast
//   7. rateLimitPlugin (spec 010) — depends on redis-plugin; placed
//      before routes so the preHandler is in scope
//   8. healthPlugin (spec 011) — replaces inline stubs; SIGTERM in
//      src/server.ts calls app.readinessGate.shutDown() during drain

import Fastify, { type FastifyInstance } from 'fastify'

import { errorHandlerPlugin } from './lib/errors/index.js'
import { healthPlugin } from './lib/health/index.js'
import { httpResponsePlugin } from './lib/http/index.js'
import { createLogger } from './lib/logger/index.js'
import { rateLimitPlugin } from './lib/rate-limit/index.js'
import { redisPlugin } from './lib/redis/index.js'
import { corsPlugin, helmetPlugin } from './lib/security/index.js'
import type { Config } from './config/schema.js'

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
  }
}

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: createLogger(config) })

  app.decorate('config', config)

  await app.register(errorHandlerPlugin)

  await app.register(helmetPlugin)
  await app.register(corsPlugin)
  await app.register(httpResponsePlugin)
  await app.register(redisPlugin)
  await app.register(rateLimitPlugin)
  await app.register(healthPlugin)

  return app
}
