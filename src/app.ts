// buildApp() factory — produces a fully configured Fastify instance.
//
// Used by:
//   - src/server.ts        prod entrypoint
//   - tests/helpers/app.ts integration test harness (spec 013 §8.2)
//
// Order of operations:
//   1. Construct Fastify with logger driven by raw process.env.LOG_LEVEL
//      (we cannot read app.config yet — @fastify/env has not run).
//   2. Register @fastify/env → validates env vars per spec 001 §4.3
//      and decorates app.config.
//   3. Run postValidate(app.config) for cross-field invariants
//      (spec 001 §4.4).
//   4. Register infrastructure plugins (TODO — landed module by module).
//   5. Register health probes (spec 011 stubs for now; spec 014 §6 binds
//      them to K8s probes).

import fastifyEnv from '@fastify/env'
import Fastify, { type FastifyInstance } from 'fastify'

import { postValidate } from './config/post-validate.js'
import { type Config, ConfigSchema } from './config/schema.js'

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  })

  await app.register(fastifyEnv, {
    schema: ConfigSchema,
    // `quiet: true` suppresses dotenv's startup tips. Existing process.env
    // values are NOT overwritten (dotenv default), which is what tests rely on.
    dotenv: { quiet: true },
    confKey: 'config',
  })

  postValidate(app.config)

  // Health probes — stubs that always succeed. Real implementations
  // (readiness gate flip on SIGTERM, DB ping, etc.) land with spec 011.
  app.get('/health/live', () => ({ status: 'ok' }))
  app.get('/health/ready', () => ({ status: 'ok' }))
  app.get('/health/startup', () => ({ status: 'ok' }))

  return app
}
