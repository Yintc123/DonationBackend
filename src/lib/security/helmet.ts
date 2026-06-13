// Spec 012 §4 + §5 — security headers via @fastify/helmet.
//
// What helmet covers natively (spec 012 §4.1):
//   - Strict-Transport-Security   (max-age from HSTS_MAX_AGE_SEC)
//   - X-Content-Type-Options      (nosniff, helmet default)
//   - X-Frame-Options             (DENY — spec 012 upgrades from helmet's SAMEORIGIN)
//   - Referrer-Policy             (no-referrer, helmet default)
//   - Cross-Origin-Opener-Policy  (same-origin, helmet default)
//   - Cross-Origin-Embedder-Policy(require-corp, helmet default)
//   - Cross-Origin-Resource-Policy(same-site — spec 012 overrides helmet default of same-origin)
//   - X-DNS-Prefetch-Control      (off, helmet default)
//   - X-Download-Options          (noopen, helmet default)
//   - X-Permitted-Cross-Domain-Policies (none, helmet default)
//   - X-Powered-By                (removed, helmet default)
//   - Content-Security-Policy     (spec 012 §5.1 — exact directives)
//
// What helmet does NOT cover and we set via onSend (spec 012 §4.1):
//   - Permissions-Policy
//
// We use `useDefaults: false` on CSP so we don't inherit helmet's default
// directives (e.g. script-src 'self', upgrade-insecure-requests) — spec 012
// §5.1 demands the literal four directives, nothing more, nothing less.

import fastifyHelmet from '@fastify/helmet'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'

/** Spec 012 §4.1 — Permissions-Policy features (all disabled). */
const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'camera=()',
  'geolocation=()',
  'microphone=()',
  'payment=()',
  'usb=()',
].join(', ')

const helmetPluginAsync: FastifyPluginAsync = async (app: FastifyInstance) => {
  await app.register(fastifyHelmet, {
    // Spec 012 §4.1 — HSTS driven by env config.
    strictTransportSecurity: {
      maxAge: app.config.HSTS_MAX_AGE_SEC,
      includeSubDomains: app.config.HSTS_INCLUDE_SUBDOMAINS,
      preload: app.config.HSTS_PRELOAD,
    },
    // Spec 012 §4.1 — DENY (upgrade from helmet's SAMEORIGIN).
    xFrameOptions: { action: 'deny' },
    // Spec 012 §4.1 — same-site (override helmet default of same-origin).
    crossOriginResourcePolicy: { policy: 'same-site' },
    // helmet defaults already match spec 012 §4.1 for the rest, but we
    // pin them explicitly so the contract is visible at the registration
    // site rather than implicit in helmet's version.
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: { policy: 'require-corp' },
    referrerPolicy: { policy: 'no-referrer' },
    // Spec 012 §5.1 — exact four directives, no helmet defaults sneaking in.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
  })

  // Spec 012 §4.1 — Permissions-Policy is not natively supported by helmet,
  // so we attach via onSend. Runs after helmet so we don't conflict.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Permissions-Policy', PERMISSIONS_POLICY)
  })
}

export const helmetPlugin = fp(helmetPluginAsync, {
  name: 'jko-helmet',
  fastify: '5.x',
  dependencies: [],
})
