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
      // staticCSP: true 會塞 `upgrade-insecure-requests` 與
      // `block-all-mixed-content` 兩個 directive,瀏覽器會把所有 css/js
      // 強制升 https,純 HTTP demo server 直接 ERR_SSL_PROTOCOL_ERROR。
      // 關掉並由下方 onSend 對 /docs 路徑覆寫一個 swagger-friendly 但不
      // 強制升級的 CSP(同時取代 helmetPlugin 的 default-src 'none')。
      staticCSP: false,
    })

    // /docs 專用的安全標頭覆寫(spec 012 §4.1 在純 HTTP demo 場景的例外):
    //   - 用更寬鬆的 CSP 允許 swagger-ui-bundle.js / inline 初始化腳本與
    //     inline style,但不寫 upgrade-insecure-requests / block-all-mixed-content。
    //   - 撤掉 COEP / COOP(瀏覽器在非安全來源本來就會 ignore,且 COEP
    //     require-corp 會封掉 swagger-ui 的 bundle 載入)。
    // 不在這層動 HSTS — 瀏覽器本來就只信 HTTPS 回傳的 HSTS;若 demo 上線
    // 改 HTTPS 也不必移除這段(CSP 仍然允許所有 swagger 必要資源)。
    app.addHook('onSend', async (req, reply) => {
      const path = req.url.split('?')[0] ?? ''
      if (path === '/docs' || path.startsWith('/docs/')) {
        reply.header(
          'Content-Security-Policy',
          "default-src 'self'; base-uri 'self'; font-src 'self' data:; " +
            "frame-ancestors 'none'; img-src 'self' data: validator.swagger.io; " +
            "object-src 'none'; script-src 'self' 'unsafe-inline'; " +
            "style-src 'self' 'unsafe-inline'",
        )
        reply.removeHeader('Cross-Origin-Embedder-Policy')
        reply.removeHeader('Cross-Origin-Opener-Policy')
      }
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
