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

import { authContextPlugin, authPlugin, requireAdmin } from './lib/auth/index.js'
import type { TokenSecrets } from './lib/auth/index.js'
import { googleAuthPlugin } from './lib/auth-google/index.js'
import { type Clock, systemClock } from './lib/clock.js'
import { errorHandlerPlugin } from './lib/errors/index.js'
import { healthPlugin } from './lib/health/index.js'
import { httpResponsePlugin, USER_API_VERSIONS } from './lib/http/index.js'
import { createLogger, loggerPolicyPlugin } from './lib/logger/index.js'
import { openapiPlugin } from './lib/openapi/index.js'
import { prismaPlugin } from './lib/prisma/index.js'
import { parseTrustedProxies, rateLimitPlugin } from './lib/rate-limit/index.js'
import { redisPlugin } from './lib/redis/index.js'
import { s3Plugin } from './lib/s3/index.js'
import { corsPlugin, helmetPlugin } from './lib/security/index.js'
import { registerCategoryRoutes } from './routes/user/donation/categories.js'
import { registerCharityRoutes } from './routes/user/donation/charities.js'
import { registerDonationProjectRoutes } from './routes/user/donation/donation-projects.js'
import { registerAdminOrderRoutes } from './routes/cms/orders.js'
import { registerCategoryAdminRoutes } from './routes/cms/donation/categories.js'
import { registerCharityAdminRoutes } from './routes/cms/donation/charities.js'
import { registerProjectAdminRoutes } from './routes/cms/donation/donation-projects.js'
import { registerOrderRoutes } from './routes/user/donation/orders.js'
import { registerSaleItemAdminRoutes } from './routes/cms/donation/sale-items.js'
import { registerSaleItemRoutes } from './routes/user/donation/sale-items.js'
import { registerPresignUploadRoute } from './routes/cms/uploads.js'
import type { Config } from './config/schema.js'

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
    // spec 021 §7.7 / spec 022 §4.0 — clock seam; route handlers forward
    // `req.server.clock` to services as `deps.clock`. Production = systemClock,
    // tests override via app.decorate('clock', ...) before buildApp returns.
    clock: Clock
    // spec 020 v0.2 §2.3 — admin routes pull token secrets to verify
    // role=0 access tokens. Set by authPlugin.
    tokenSecrets: TokenSecrets
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
    // Spec 022 §4.0 / §5.1 — body schemas set `additionalProperties: false`
    // and rely on Ajv rejecting unknown properties. Fastify 5's default
    // `removeAdditional: 'all'` would silently strip them and quietly let
    // `additionalProperties: false` pass, so we disable removal globally.
    // Safe because no existing schema in this codebase depends on silent
    // stripping (only order bodies set `additionalProperties` at all).
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
  })

  app.decorate('config', config)
  app.decorate('clock', systemClock)

  await app.register(loggerPolicyPlugin)
  await app.register(errorHandlerPlugin)

  await app.register(helmetPlugin)
  await app.register(corsPlugin)
  await app.register(httpResponsePlugin)
  // Spec 016 §12.1 (B5) — OpenAPI / Swagger UI for dev introspection.
  // Registered BEFORE the routes so it can walk and document them.
  // No-op in production (the plugin self-skips on NODE_ENV).
  await app.register(openapiPlugin)
  await app.register(prismaPlugin)
  await app.register(redisPlugin)
  await app.register(rateLimitPlugin)
  await app.register(authPlugin)
  // Spec 020 §11 / spec 022 §8.2 — best-effort JWT decode into req.user on
  // every request (onRequest hook). Must register AFTER authPlugin (depends
  // on app.tokenSecrets); the rate-limit per-user layer reads req.user.sub.
  await app.register(authContextPlugin)
  await app.register(googleAuthPlugin)
  // Spec 018 §3 — s3Plugin owns app.s3 / s3Config / s3HealthProbe. Placed
  // AFTER rate-limit so the presign route inherits the global preHandler,
  // and BEFORE healthPlugin because healthPlugin registers /health/storage
  // by detecting the s3HealthProbe decorator (spec 018 §10 / spec 011 §3).
  await app.register(s3Plugin)
  await app.register(healthPlugin)
  // === Spec 023 §2 — three URL surfaces ===
  //
  // `/auth/*` is mounted by authPlugin / googleAuthPlugin (prefix wrapper
  // inside each plugin); not visible here.
  //
  // Below: `/user/v{N}/*` for user-facing business APIs (spec 016/017/022
  // public) and `/cms/*` for admin write APIs (spec 018/020/022 admin).

  // === Surface: /user/v{N} — versioned user-facing business APIs ===
  // Spec 023 §3.3 — the version array drives the mount loop. Adding 'v2'
  // mounts a second prefix automatically and the onRequest hook seeds
  // req.apiVersion for handlers that need to branch (spec 023 §5.2).
  for (const version of USER_API_VERSIONS) {
    await app.register(
      async (userApi) => {
        userApi.addHook('onRequest', async (req) => {
          req.apiVersion = version
        })
        // Donation public read endpoints (spec 016 / spec 017).
        await userApi.register(registerCategoryRoutes)
        await userApi.register(registerCharityRoutes)
        await userApi.register(registerDonationProjectRoutes)
        await userApi.register(registerSaleItemRoutes)
        // Donation order create + lifecycle + GET detail (spec 022 phase 2-3).
        await userApi.register(registerOrderRoutes)
      },
      { prefix: `/user/${version}` },
    )
  }

  // === Surface: /cms — admin / back-office (unversioned per spec 023 §2.3) ===
  // Scope-level preHandler gates the entire surface — individual handlers
  // no longer call `requireAdmin` (spec 023 §4.4). Spec 020 §2.3 contract
  // (401 missing / expired / disabled, 403 wrong role) is enforced once,
  // here, before any handler body runs.
  await app.register(
    async (cms) => {
      cms.addHook('preHandler', async (req) => {
        await requireAdmin(req, cms.prisma, cms.tokenSecrets)
      })
      // Donation entity admin write endpoints (spec 020 §5).
      await cms.register(registerCharityAdminRoutes)
      await cms.register(registerProjectAdminRoutes)
      await cms.register(registerSaleItemAdminRoutes)
      await cms.register(registerCategoryAdminRoutes)
      // Admin order endpoints (spec 022 phase 4).
      await cms.register(registerAdminOrderRoutes)
      // S3 presign (spec 018; moved from /v1/donation/uploads/presign).
      await cms.register(registerPresignUploadRoute)
    },
    { prefix: '/cms' },
  )

  return app
}
