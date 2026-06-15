// Spec 018 §5 — S3 key namespace helpers.
//
// Pattern:  donation/{entity}/{id}/{purpose}.{ext}
//
// Choosing a structured path (entity / id / purpose) over a flat
// "donation/{uuid}.png" buys ops debug-ability — staring at S3 console
// you can tell which DB row each object belongs to. The trade-off is some
// path-structure leakage; for public donation assets that's acceptable
// (spec 018 §5.4).

import { BadRequestError, ErrorCode, ValidationError } from '../errors/index.js'

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

// ── Object key validator (read path) ──────────────────────────────────────
//
// Used by callers that receive a key string from outside (frontend POST of
// logoKey after a presigned upload, seed scripts, admin API write paths)
// and need to confirm it matches our contract before persisting (spec 015
// §3.3 — "application 層 regex 驗證, DB 層長度限制").
//
// Read-write asymmetry — IMPORTANT:
//   - WRITE path (`buildKey`): never produces `.jpeg`; image/jpeg is fixed
//     to `.jpg` (spec 018 §5.1.1) so the same image cannot land under two
//     distinct keys.
//   - READ path (this regex): accepts BOTH `.jpg` AND `.jpeg`. If a future
//     bulk-import or backfill writes `.jpeg` keys, we still want to read
//     them, and the public-bucket policy doesn't distinguish.
// The asymmetry is deliberate, not a bug.

const OBJECT_KEY_ENTITY = ENTITIES.join('|')
const OBJECT_KEY_PURPOSE = PURPOSES.join('|')
// UUID character class is case-insensitive (Prisma's @default(uuid()) emits
// lowercase but the contract permits uppercase too); entity / purpose / ext
// are case-sensitive lowercase per spec 018 §5.3.
const OBJECT_KEY_UUID =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}'

export const OBJECT_KEY_REGEX = new RegExp(
  `^donation/(${OBJECT_KEY_ENTITY})/${OBJECT_KEY_UUID}/(${OBJECT_KEY_PURPOSE})\\.(png|jpg|jpeg|webp|gif)$`,
)

/** True iff `key` matches the spec 015 §3.3 / spec 018 §5.1 contract. */
export function isValidObjectKey(key: string): boolean {
  return OBJECT_KEY_REGEX.test(key)
}

/**
 * Throws {@link ValidationError} when `key` does not match the object-key
 * contract. Use on write paths (DB insert / update of logoKey / coverImageKey).
 */
export function assertValidObjectKey(key: string, fieldPath = '/objectKey'): void {
  if (!isValidObjectKey(key)) {
    throw new ValidationError({
      errors: [
        {
          path: fieldPath,
          message:
            'object key must match donation/{entity}/{uuid}/{purpose}.{ext} (spec 015 §3.3)',
          code: 'invalid.object_key',
        },
      ],
    })
  }
}

/**
 * Spec 020 §10 INVALID_S3_KEY_BINDING — beyond shape, assert the key's
 * entity segment matches `expectedEntity`. PATCH callers can additionally
 * pass `expectedId` so a client cannot reassign a previously-uploaded key
 * onto a different row.
 *
 * Why entity is enforced but id is optional:
 *   - On POST, the row id is server-generated; the client uploaded with a
 *     client-generated uuid placeholder (or a previously-reserved id), so
 *     id binding cannot be enforced until that flow is spec'd (spec 018
 *     §14 OQ).
 *   - On PATCH, the row already has an id — passing it in catches the
 *     "drag a logoKey from row A onto row B" mistake explicitly.
 */
export function assertS3KeyBinding(
  key: string,
  expectedEntity: UploadEntity,
  fieldPath: string,
  expectedId?: string,
): void {
  const match = OBJECT_KEY_REGEX.exec(key)
  if (match === null) {
    // Shape failure already a 400 via assertValidObjectKey; this branch is
    // defensive — callers usually invoke assertValidObjectKey first.
    assertValidObjectKey(key, fieldPath)
    return
  }
  const keyEntity = match[1]
  if (keyEntity !== expectedEntity) {
    throw new BadRequestError({
      code: ErrorCode.INVALID_S3_KEY_BINDING,
      message: `${fieldPath} entity segment "${keyEntity}" does not match "${expectedEntity}"`,
      details: { fieldPath, expectedEntity, actualEntity: keyEntity },
    })
  }
  if (expectedId !== undefined) {
    // Path: donation/{entity}/{id}/{purpose}.{ext} — third segment.
    const id = key.split('/')[2]
    if (id !== expectedId) {
      throw new BadRequestError({
        code: ErrorCode.INVALID_S3_KEY_BINDING,
        message: `${fieldPath} id segment does not match the resource id`,
        details: { fieldPath, expectedId, actualId: id },
      })
    }
  }
}
