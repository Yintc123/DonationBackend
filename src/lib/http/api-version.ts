// Spec 023 §3.3 — User-facing API versioning, URI-style.
//
// Single source of truth for which `/user/v{N}/...` prefixes the app
// mounts. Add a new version = append a string to USER_API_VERSIONS;
// remove a version = delete it from the array (the corresponding
// prefix register loop in app.ts stops mounting → 404).
//
// Spec 023 §2.2 — auth (`/auth/*`) and cms (`/cms/*`) are intentionally
// NOT versioned; this module is only consumed by the `/user/v{N}` mount
// loop. Anywhere else that reads `req.apiVersion` is in a `/user/v{N}`
// handler scope (an onRequest hook in app.ts injects the value); on
// `/auth/*` or `/cms/*` the field is undefined by design.

export const USER_API_VERSIONS = ['v1'] as const

export type UserApiVersion = (typeof USER_API_VERSIONS)[number]

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Present iff the request matched a route mounted under `/user/v{N}`.
     * Undefined on `/auth/*` and `/cms/*` (spec 023 §2.1 / §2.3 surfaces
     * are not versioned). Handlers that need to differentiate behaviour
     * across versions read this field per spec 023 §5.2 (model B —
     * if-else inline) or §5.3 (model C — split handlers).
     */
    apiVersion?: UserApiVersion
  }
}
