// Spec 019 — public surface of the cache module.
//
// Consumers compose:
//   key = buildCacheKey('proj:detail:v1', [id, locale])
//   const value = await withCache({ redis, key, ttlSec: 60, logger, loader })
// And on writes (future admin paths):
//   await invalidate(redis, key, logger)

export { buildCacheKey } from './keys.js'
export {
  donationCacheKeysFor,
  invalidateDonationEntity,
  type DonationEntity,
  type InvalidateDonationContext,
} from './invalidate-donation.js'
export { parseJson, stableStringify } from './json.js'
export { invalidate, withCache, type CacheOptions } from './with-cache.js'
