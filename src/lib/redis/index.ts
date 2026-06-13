// Spec 006 — public surface of the Redis module.
//
// Consumers register the plugin (spec 006 §3) and use the pure helpers for
// key construction (spec 006 §4). The higher-level CacheTierApi / LockApi /
// RateLimitApi from spec 006 §16 land later; this module currently exposes
// only the connection lifecycle + key helpers.

export { redisPlugin } from './plugin.js'
export {
  APP_PREFIX,
  buildKey,
  isValidIdentifierSegment,
  KEY_PURPOSES,
  type KeyPurpose,
} from './key-prefix.js'
export { buildRedisPluginOptions, type RedisConfigSlice } from './options.js'
