// Spec 018 §4 — S3 module config slice.
//
// Reads from the shared spec-001 Config. We keep the slice interface narrow
// so this module stays decoupled from the rest of the app — tests can pass a
// plain object that matches S3ConfigSlice without constructing the whole
// schema (mirrors src/lib/redis/options.ts pattern).

export interface S3ConfigSlice {
  S3_BUCKET: string
  S3_REGION: string
  S3_ENDPOINT: string
  S3_FORCE_PATH_STYLE: string
  S3_PUBLIC_URL_BASE: string
  S3_PRESIGN_TTL_SECONDS: number
  S3_MAX_UPLOAD_BYTES: number
}

export interface S3Config {
  bucket: string
  region: string
  /** undefined ⇒ use the AWS default endpoint resolution */
  endpoint: string | undefined
  forcePathStyle: boolean
  /** empty string ⇒ url.ts derives the base from bucket + region */
  publicUrlBase: string
  presignTtlSeconds: number
  maxUploadBytes: number
}

export class S3ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'S3ConfigError'
  }
}

/**
 * Strict boolean parse per spec 018 §4 row table — only the literal string
 * 'true' is accepted. Avoids the classic '1' / 'yes' / 'TRUE' coercion
 * surprises that flipped path-style on bucket migrations.
 */
export function parseForcePathStyle(value: string): boolean {
  return value === 'true'
}

export function resolveS3Config(slice: S3ConfigSlice): S3Config {
  if (!slice.S3_BUCKET) {
    throw new S3ConfigError(
      'S3_BUCKET is required (spec 018 §4.2); dev may use a LocalStack name such as "local-dev-assets"',
    )
  }
  if (!slice.S3_REGION) {
    throw new S3ConfigError(
      'S3_REGION is required (spec 018 §4.2); align with the ECS deployment region (ADR 008)',
    )
  }

  const forcePathStyle = parseForcePathStyle(slice.S3_FORCE_PATH_STYLE)

  // Spec 018 §4.2 — virtual-hosted style URLs cannot reach buckets whose name
  // contains a dot (TLS SAN matches `*.s3.<region>.amazonaws.com`). Catch
  // this at config load so the deploy fails before the first request signs.
  if (!forcePathStyle && slice.S3_BUCKET.includes('.')) {
    throw new S3ConfigError(
      `S3_BUCKET="${slice.S3_BUCKET}" contains a dot; virtual-hosted style URLs do not support that. Either pick a bucket name without dots, or set S3_FORCE_PATH_STYLE=true.`,
    )
  }

  return {
    bucket: slice.S3_BUCKET,
    region: slice.S3_REGION,
    endpoint: slice.S3_ENDPOINT ? slice.S3_ENDPOINT : undefined,
    forcePathStyle,
    publicUrlBase: slice.S3_PUBLIC_URL_BASE,
    presignTtlSeconds: slice.S3_PRESIGN_TTL_SECONDS,
    maxUploadBytes: slice.S3_MAX_UPLOAD_BYTES,
  }
}
