// Spec 009 — public surface of the HTTP success-response module.
//
// Consumers should import from this barrel rather than reaching into
// individual files, so internal layout can evolve without breaking callers.

export { buildETag, ifNoneMatch } from './etag.js'
export { default as httpResponsePlugin } from './plugin.js'
export { HttpStatus, type HttpSuccessStatus } from './status.js'
export {
  PageInfoSchema,
  paginatedEnvelope,
  paginatedSchema,
  type PageInfo,
  type PaginatedEnvelope,
  type PaginatedInput,
} from './pagination.js'
export { registerWithV1Alias } from './v1-alias.js'
