// Spec 018 §5.1.1 / §7.4 — upload policy: contentType whitelist + ext mapping
// + size assertion.
//
// Pure functions. The mapping is intentionally narrow: only image/* MIME types
// the product UI emits. Adding a new type requires a spec update so reviewers
// notice (storage costs, CDN cache, abuse surface all change).
//
// Design choice — image/jpeg → 'jpg' (NOT 'jpeg') per spec 018 §5.1.1:
// allowing both '.jpg' and '.jpeg' would let the same logical image be stored
// under two distinct keys ("same image, two URLs"). One canonical ext keeps
// the key contract tight.

import {
  BadRequestError,
  ErrorCode,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../errors/index.js'

const CONTENT_TYPE_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
} as const satisfies Record<string, string>

export type AllowedContentType = keyof typeof CONTENT_TYPE_TO_EXT
export type AllowedExt = (typeof CONTENT_TYPE_TO_EXT)[AllowedContentType]

export const ALLOWED_CONTENT_TYPES = Object.freeze(
  Object.keys(CONTENT_TYPE_TO_EXT) as AllowedContentType[],
)

export function isAllowedContentType(value: string): value is AllowedContentType {
  return value in CONTENT_TYPE_TO_EXT
}

export function contentTypeToExt(contentType: AllowedContentType): AllowedExt {
  return CONTENT_TYPE_TO_EXT[contentType]
}

/**
 * Spec 018 §7.4 — 415 UNSUPPORTED_MEDIA_TYPE when contentType not in whitelist.
 *
 * NOTE: callers MUST normalise the wire value (lowercase, strip parameters
 * like `; charset=utf-8`) before invoking this. We deliberately do not do it
 * here so the policy is a pure exact-match check.
 */
export function assertContentType(value: string): AllowedContentType {
  if (!isAllowedContentType(value)) {
    throw new UnsupportedMediaTypeError({
      message: `Unsupported contentType "${value}"; allowed: ${ALLOWED_CONTENT_TYPES.join(', ')}`,
      details: { allowed: [...ALLOWED_CONTENT_TYPES] },
    })
  }
  return value
}

/**
 * Spec 018 §7.4 — 400 VALIDATION_FAILED when fileSize exceeds limit, is
 * non-positive, or non-integer.
 *
 * S3's pre-signed URL embeds ContentLength in the SigV4 signature (spec
 * 018 §7.1.1). If we let this through, the signed URL silently allows any
 * size — defeating the cap entirely. So we check at the application layer
 * BEFORE signing.
 */
export function assertContentLength(size: number, maxBytes: number): void {
  if (!Number.isInteger(size) || size <= 0) {
    throw new ValidationError({
      errors: [{ path: '/fileSize', message: 'fileSize must be a positive integer', code: 'invalid' }],
    })
  }
  if (size > maxBytes) {
    throw new BadRequestError({
      message: `fileSize ${size.toString()} exceeds maximum ${maxBytes.toString()} bytes`,
      code: ErrorCode.VALIDATION_FAILED,
      details: { fileSize: size, maxBytes },
    })
  }
}
