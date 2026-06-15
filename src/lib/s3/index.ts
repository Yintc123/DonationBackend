// Spec 018 — public surface of the S3 storage module.
//
// Consumers reach the client only via `app.s3` / `app.s3Config` (decorated by
// the plugin). Pure helpers (key / url / policy) are exported for routes and
// for the seed scripts that need to compute the public URL of a key.

export { closeS3Client, createS3Client } from './client.js'
export {
  parseForcePathStyle,
  resolveS3Config,
  S3ConfigError,
  type S3Config,
  type S3ConfigSlice,
} from './config.js'
export { mapS3Error } from './errors.js'
export { createStorageProbe, type StorageProbeResult } from './health.js'
export {
  ALLOWED_EXTS,
  assertS3KeyBinding,
  assertValidObjectKey,
  buildKey,
  ENTITIES,
  isUuid,
  isValidObjectKey,
  OBJECT_KEY_REGEX,
  PURPOSES,
  type BuildKeyInput,
  type UploadEntity,
  type UploadExt,
  type UploadPurpose,
} from './key.js'
export { s3Plugin } from './plugin.js'
export {
  ALLOWED_CONTENT_TYPES,
  assertContentLength,
  assertContentType,
  contentTypeToExt,
  isAllowedContentType,
  type AllowedContentType,
  type AllowedExt,
} from './policy.js'
export { getPresignedUploadUrl, type PresignInput, type PresignResult } from './presigned.js'
export { objectUrl, type ObjectUrlConfig } from './url.js'
