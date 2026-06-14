// Spec 018 §7 — pre-signed PUT URL generator.
//
// Critical: ContentLength MUST be on the PutObjectCommand so SigV4 includes
// the `content-length` header in SignedHeaders (spec 018 §7.1.1). Without it,
// the signature only covers URL + content-type, letting clients upload any
// size against a 5MB-issued signature.
//
// Why no try/catch:
//   `getSignedUrl()` runs PURE LOCAL SigV4 arithmetic — it never hits S3
//   (spec 018 §11.2 made the same point as rationale for "do not retry").
//   The only errors it can raise are programmer / SDK bugs (e.g. missing
//   credentials, malformed config). Wrapping them in `mapS3Error` would be
//   misleading because none of the S3ServiceException branches there can
//   apply. We let the error bubble — spec 005's errorHandler will turn it
//   into an opaque 500 INTERNAL with the cause logged.

import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export interface PresignInput {
  client: S3Client
  bucket: string
  key: string
  contentType: string
  contentLength: number
  ttlSeconds: number
}

export interface PresignResult {
  url: string
  expiresAt: Date
}

export async function getPresignedUploadUrl(input: PresignInput): Promise<PresignResult> {
  const command = new PutObjectCommand({
    Bucket: input.bucket,
    Key: input.key,
    ContentType: input.contentType,
    // Spec 018 §7.1.1 — see header comment; do NOT remove.
    ContentLength: input.contentLength,
  })

  const url = await getSignedUrl(input.client, command, { expiresIn: input.ttlSeconds })

  return {
    url,
    expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
  }
}
