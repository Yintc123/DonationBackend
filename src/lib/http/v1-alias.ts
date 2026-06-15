// Spec 007 / 008 URL versioning compat — backward-compatible `/v1` alias.
//
// Background:
//   - Spec 007 / 008 shipped auth endpoints under `/auth/*` (no version
//     prefix).
//   - Spec 015 onwards uses `/v1/donation/*` (versioned prefix).
//   - BFF / external callers gradually standardise on `/v1/...` and start
//     calling `/v1/auth/register` etc. — those would 404 against backend
//     today.
//
// We make a single handler reachable under both URLs so BFF code can move
// over at its own pace without a flag day, and so any future client that
// guesses `/v1` works.
//
// Why dual-register (call `app.route` twice) instead of 308 redirect:
//   1. POST + body: some BFF env (Next.js route handlers, certain axios
//      configs) drop request body across a redirect even with 308.
//   2. One round trip on both URLs — no extra latency on the `/v1` alias.
//   3. Logs / metrics still distinguish which URL the client hit
//      (`routerPath` in request log), so we can measure `/v1` adoption
//      and eventually deprecate the unversioned form.
//
// Why dual-register instead of `app.register(routes, { prefix: '/v1' })`:
//   Auth routes are registered as plain async function calls
//   (`registerAuthRoutes(app, deps)`) per existing convention, not as
//   Fastify plugins. Re-registering as a prefixed plugin would require
//   restructuring three route files and the authPlugin glue. The helper
//   below keeps the change scoped to one extra `app.route` call per
//   route definition.
//
// Schema reuse note:
//   Fastify compiles `schema` per-route (no cache keyed by object
//   identity), so passing the same schema object to two `app.route` calls
//   produces two independent validators. No clone needed.

import type { FastifyInstance, RouteGenericInterface, RouteOptions } from 'fastify'

const V1_PREFIX = '/v1'

/**
 * Register the route under its canonical URL AND a `/v1`-prefixed alias.
 *
 * Both routes share the exact same handler + schema + config, so behaviour
 * is identical regardless of which URL the client calls. Use this for any
 * spec 007 / 008 auth endpoint that BFF / external callers may probe
 * under either shape.
 *
 * Generic mirrors `app.route<T>` so callers keep their typed request
 * shapes:
 *
 *   registerWithV1Alias<{ Body: RegisterBody }>(app, {
 *     method: 'POST',
 *     url: '/auth/register',
 *     handler: async (req) => { ... req.body is RegisterBody ... },
 *   })
 *
 * The canonical URL stays the primary entry point; the `/v1` URL is the
 * compat alias and the one we expect to standardise on going forward.
 */
export function registerWithV1Alias<RouteGeneric extends RouteGenericInterface = RouteGenericInterface>(
  app: FastifyInstance,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opts: RouteOptions<any, any, any, RouteGeneric>,
): void {
  app.route(opts)
  // Defensive: never double-prefix. If a caller passes `/v1/foo` we skip
  // the alias (it's already the versioned form).
  if (opts.url.startsWith(V1_PREFIX + '/') || opts.url === V1_PREFIX) return
  app.route({ ...opts, url: `${V1_PREFIX}${opts.url}` })
}
