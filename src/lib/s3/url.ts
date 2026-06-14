// Spec 018 §8 — public-read URL builder.
//
// Three regimes (priority order):
//   1. publicUrlBase set     → "<base>/<key>"          (CDN / CloudFront)
//   2. forcePathStyle = true → "https://s3.<region>.amazonaws.com/<bucket>/<key>"
//                              (LocalStack, MinIO — bucket containing dots, etc.)
//   3. default               → "https://<bucket>.s3.<region>.amazonaws.com/<key>"
//                              (virtual-hosted style)
//
// Note: the bucket-with-dot edge case is also rejected at config load time in
// config.ts when virtual-hosted style is in use.

export interface ObjectUrlConfig {
  bucket: string
  region: string
  /** Empty string ⇒ derive from bucket + region (virtual-hosted or path style). */
  publicUrlBase: string
  forcePathStyle: boolean
}

export function objectUrl(key: string, config: ObjectUrlConfig): string {
  const base = resolveBase(config)
  return `${base}/${key}`
}

function resolveBase(config: ObjectUrlConfig): string {
  if (config.publicUrlBase) {
    return config.publicUrlBase.replace(/\/+$/, '')
  }
  if (config.forcePathStyle) {
    return `https://s3.${config.region}.amazonaws.com/${config.bucket}`
  }
  return `https://${config.bucket}.s3.${config.region}.amazonaws.com`
}
