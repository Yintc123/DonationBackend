// Spec 016 §12.1 v0.14 (B5) — OpenAPI / Swagger UI, all environments.
//
// `@fastify/swagger` walks every route registered AFTER it and synthesises
// an OpenAPI 3 document from the TypeBox `schema` blocks already attached
// to each `app.route(...)` call. `@fastify/swagger-ui` then mounts a
// browser UI at `/docs` with "Try it out" buttons.
//
// Demo project — we deliberately expose `/docs` + `/openapi.json` in every
// NODE_ENV. The contract IS the deliverable: reviewers should be able to
// open it on whatever URL the demo is hosted at, with no extra flag or
// tunnel. If this ever turns into a real service, gate behind
// `requireAdmin` or an internal-only ingress instead of NODE_ENV.

import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

export const openapiPlugin = fp(
  async (app: FastifyInstance) => {
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
