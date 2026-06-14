// Spec 018 §5 — S3 key namespace helpers.
//
// Pattern:  donation/{entity}/{id}/{purpose}.{ext}
//
// Choosing a structured path (entity / id / purpose) over a flat
// "donation/{uuid}.png" buys ops debug-ability — staring at S3 console
// you can tell which DB row each object belongs to. The trade-off is some
// path-structure leakage; for public donation assets that's acceptable
// (spec 018 §5.4).

import { ErrorCode, ValidationError } from '../errors/index.js'

export const ENTITIES = Object.freeze([
  'charities',
  'donation-projects',
  'sale-items',
] as const)
export type UploadEntity = (typeof ENTITIES)[number]

export const PURPOSES = Object.freeze(['logo', 'cover'] as const)
export type UploadPurpose = (typeof PURPOSES)[number]

// Spec 018 §5.1: only these lowercase extensions land in NEW keys (image/jpeg
// produces 'jpg', not 'jpeg' — see policy.ts CONTENT_TYPE_TO_EXT). 'jpeg' is
// retained on the read side for backward compatibility but is not accepted
// here.
export const ALLOWED_EXTS = Object.freeze(['png', 'jpg', 'webp', 'gif'] as const)
export type UploadExt = (typeof ALLOWED_EXTS)[number]

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_V4_RE.test(value)
}

function isEntity(value: string): value is UploadEntity {
  return (ENTITIES as readonly string[]).includes(value)
}

function isPurpose(value: string): value is UploadPurpose {
  return (PURPOSES as readonly string[]).includes(value)
}

function isExt(value: string): value is UploadExt {
  return (ALLOWED_EXTS as readonly string[]).includes(value)
}

export interface BuildKeyInput {
  entity: UploadEntity
  /** Object UUID — owner's DB row id. MUST be a UUID v4 to prevent path injection. */
  id: string
  purpose: UploadPurpose
  /** Lowercase, whitelisted ext. Use {@link contentTypeToExt} to derive from MIME. */
  ext: UploadExt
}

/**
 * Build the canonical S3 key for an upload.
 *
 * Validates entity / purpose / ext against their whitelist AND that `id` is a
 * UUID v4 — the only path segment derived from user input. Anything else
 * could let an attacker write outside the expected prefix (e.g. inject
 * `../`), or split into multiple objects.
 */
export function buildKey(input: BuildKeyInput): string {
  if (!isEntity(input.entity)) {
    throw new ValidationError({
      errors: [
        {
          path: '/entity',
          message: `entity must be one of: ${ENTITIES.join(', ')}`,
          code: 'invalid.entity',
        },
      ],
    })
  }
  if (!isPurpose(input.purpose)) {
    throw new ValidationError({
      errors: [
        {
          path: '/purpose',
          message: `purpose must be one of: ${PURPOSES.join(', ')}`,
          code: 'invalid.purpose',
        },
      ],
    })
  }
  if (!isUuid(input.id)) {
    throw new ValidationError({
      errors: [
        { path: '/id', message: 'id must be a UUID v4', code: 'invalid.id' },
      ],
      code: ErrorCode.VALIDATION_FAILED,
    })
  }
  if (!isExt(input.ext)) {
    throw new ValidationError({
      errors: [
        {
          path: '/ext',
          message: `ext must be one of: ${ALLOWED_EXTS.join(', ')}`,
          code: 'invalid.ext',
        },
      ],
    })
  }
  return `donation/${input.entity}/${input.id}/${input.purpose}.${input.ext}`
}
