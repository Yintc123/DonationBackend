// Spec 016 §12.1 v0.13 (B5) — OpenAPI / Swagger UI for dev introspection.
//
// `@fastify/swagger` walks every route registered AFTER it and synthesises
// an OpenAPI 3 document from the TypeBox `schema` blocks already attached
// to each `app.route(...)` call. `@fastify/swagger-ui` then mounts a
// browser UI at `/docs` with "Try it out" buttons.
//
// Both are **dev-only**: in staging / production the plugin returns early
// without registering anything, so:
//   - GET /docs        → 404
//   - GET /docs/json   → 404
//   - GET /openapi.json → 404
// This keeps a powerful introspection surface off the public prod API
// (it would expose response shapes + every route's existence, which we
// don't need shipped externally).

import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

export const openapiPlugin = fp(
  async (app: FastifyInstance) => {
    if (app.config.NODE_ENV === 'production') return

    await app.register(fastifySwagger, {
      openapi: {
        openapi: '3.0.3',
        info: {
          title: 'JKODonation Backend',
          description:
            '2026 全端面試作業 — Backend API. Public donation read endpoints, ' +
            'auth flows (email / password + Google OIDC), object-storage presign, ' +
            'health probes. See docs/specs for the full per-module contract.',
          version: process.env.BUILD_VERSION ?? '0.0.0-dev',
        },
        servers: [
          { url: `http://${app.config.HOST}:${app.config.PORT.toString()}`, description: 'local dev' },
        ],
        tags: [
          { name: 'donation', description: 'Donation public read (spec 016 / 017)' },
          { name: 'upload', description: 'Pre-signed S3 PUT (spec 018)' },
          { name: 'auth', description: 'Email/password + Google OIDC (spec 007 / 008)' },
          { name: 'health', description: 'Liveness / readiness / startup / storage (spec 011)' },
        ],
      },
    })

    await app.register(fastifySwaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
        persistAuthorization: true,
      },
      staticCSP: true,
    })

    // Also expose the raw spec at the de-facto-standard /openapi.json so
    // external tooling (Postman import, Redocly, openapi-codegen) doesn't
    // have to grep for Swagger UI's bundled JSON endpoint.
    app.get(
      '/openapi.json',
      {
        config: { rateLimit: false },
        schema: { hide: true },
      },
      async () => app.swagger(),
    )
  },
  {
    name: 'openapi-plugin',
    fastify: '5.x',
  },
)
