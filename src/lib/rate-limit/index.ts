// Spec 010 — public surface of the rate-limit module.
//
// Routes declare per-endpoint policy via the `config.rateLimit` Fastify
// context field — see RouteRateLimitConfig. The plugin is wrapped with
// fastify-plugin so its preHandler hook applies app-wide.

export { rateLimitPlugin, type RateLimitPluginOptions } from './plugin.js'
export {
  resolveLayerConfig,
  type GlobalRateLimitDefaults,
  type LimitWindow,
  type PurposeConfig,
  type ResolvedLayer,
  type RouteRateLimitConfig,
} from './config-resolver.js'
export { buildRateLimitHeaders, type LayerDecision, type RateLimitHeaders } from './headers.js'
export {
  hashIdentifier,
  ipToSegment,
  rateLimitKey,
  routeIdFromRequest,
  windowStartMs,
  type RateLimitLayer,
} from './keys.js'
export { shouldSkipRateLimit } from './skip.js'
export {
  createSlidingWindowStore,
  type ConsumeArgs,
  type ConsumeResult,
  type SlidingWindowStore,
} from './store.js'
export { parseTrustedProxies, TrustedProxyConfigError } from './trusted-proxies.js'
export { SLIDING_WINDOW_LUA } from './script.js'
