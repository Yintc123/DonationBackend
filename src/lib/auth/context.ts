// Spec 020 §11 / spec 022 §8.2 — best-effort access-token decoding on
// every request so downstream plugins (rate-limit per-user layer) and
// route handlers can read `req.user` without each one re-verifying.
//
// Why onRequest instead of preHandler:
//   The rate-limit plugin (`src/lib/rate-limit/plugin.ts`) runs in
//   `preHandler`. A per-route `preHandler` (e.g. `requireAdmin`) registered
//   in the same lifecycle stage executes AFTER global plugin preHandlers
//   in Fastify 5, so route-level auth cannot inform global rate-limit.
//   `onRequest` is the earliest hook with access to headers, so we decode
//   the JWT there and stash claims on `req.user`. Global plugins (rate-limit)
//   and route handlers (requireAdmin) both read the same set.
//
// What this hook DOES NOT do:
//   - Validate the account is live (archivedAt / deletedAt) — that needs a
//     DB hit and only matters at the endpoint that gates writes. We leave
//     it to `requireAdmin` / `requireLiveAccountId`.
//   - Reject on missing / malformed tokens — public endpoints don't need a
//     token; failure here would break them. Silent skip; route-level guards
//     enforce when needed.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

import { type RoleValue, isRole } from './role.js'
import { verifyAccessToken } from './tokens.js'

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Best-effort decoded claims for the inbound access token. Present
     * iff a valid `Bearer <token>` header was supplied and signature
     * verification succeeded. Downstream code (rate-limit per-user,
     * requireAdmin, audit log) treats `undefined` as "anonymous".
     */
    user?: { sub: string; role?: RoleValue }
  }
}

export const authContextPlugin = fp(
  async (app: FastifyInstance) => {
    app.addHook('onRequest', async (req: FastifyRequest) => {
      const header = req.headers.authorization
      if (typeof header !== 'string' || !/^bearer /i.test(header)) return
      const token = header.slice(7).trim()
      if (token.length === 0) return
      try {
        const claims = await verifyAccessToken(token, app.tokenSecrets)
        req.user = {
          sub: claims.sub,
          role: isRole(claims.role) ? claims.role : undefined,
        }
      } catch {
        // Silent — route-level requireAdmin / requireLiveAccountId will
        // re-verify and emit a proper 401 if the endpoint actually needs auth.
      }
    })
  },
  {
    name: 'auth-context',
    fastify: '5.x',
    // Needs the tokenSecrets decorator that authPlugin sets up.
    dependencies: ['auth-password'],
  },
)
