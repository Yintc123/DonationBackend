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

import { authPlugin } from './lib/auth/index.js'
import { googleAuthPlugin } from './lib/auth-google/index.js'
import { errorHandlerPlugin } from './lib/errors/index.js'
import { healthPlugin } from './lib/health/index.js'
import { httpResponsePlugin } from './lib/http/index.js'
import { createLogger, loggerPolicyPlugin } from './lib/logger/index.js'
import { prismaPlugin } from './lib/prisma/index.js'
import { parseTrustedProxies, rateLimitPlugin } from './lib/rate-limit/index.js'
import { redisPlugin } from './lib/redis/index.js'
import { s3Plugin } from './lib/s3/index.js'
import { corsPlugin, helmetPlugin } from './lib/security/index.js'
import { registerPresignUploadRoute } from './routes/v1/donation/uploads/presign.js'
import type { Config } from './config/schema.js'

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
  }
}

export async function buildApp(config: Config): Promise<FastifyInstance> {
  // Spec 012 §6.1 — pass the CIDR allowlist (NEVER `true`); parser rejects
  // wildcards. Empty allowlist falls back to `false` so request.ip stays
  // as the socket peer, which is the safe default for dev.
  const trustedProxies = parseTrustedProxies(config.RATE_LIMIT_TRUSTED_PROXIES)
  const trustProxy = trustedProxies.length > 0 ? trustedProxies : false

  // disableRequestLogging: true → Fastify stops emitting its built-in
  // "incoming request" / "request completed" lines for every route. The
  // spec-004 loggerPolicyPlugin re-emits them for non-excluded paths
  // (skips /health/* and OPTIONS — spec 004 §6.2).
  const app = Fastify({
    logger: createLogger(config),
    trustProxy,
    disableRequestLogging: true,
  })

  app.decorate('config', config)

  await app.register(loggerPolicyPlugin)
  await app.register(errorHandlerPlugin)

  await app.register(helmetPlugin)
  await app.register(corsPlugin)
  await app.register(httpResponsePlugin)
  await app.register(prismaPlugin)
  await app.register(redisPlugin)
  await app.register(rateLimitPlugin)
  await app.register(authPlugin)
  await app.register(googleAuthPlugin)
  // Spec 018 §3 — s3Plugin owns app.s3 / s3Config / s3HealthProbe. Placed
  // AFTER rate-limit so the presign route inherits the global preHandler,
  // and BEFORE healthPlugin because healthPlugin registers /health/storage
  // by detecting the s3HealthProbe decorator (spec 018 §10 / spec 011 §3).
  await app.register(s3Plugin)
  await app.register(healthPlugin)
  await app.register(registerPresignUploadRoute)

  return app
}
