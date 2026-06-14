// Spec 018 §3 — S3Client factory + lifecycle.
//
// We do not export a module-level singleton. The Fastify plugin holds the
// instance on `app.s3` so multiple Fastify instances (parallel tests) get
// distinct clients. closeS3Client() releases the SDK's pooled HTTP handler
// — invoked via the spec 011 graceful-shutdown chain (`app.close()` → the
// plugin's onClose hook).

import { S3Client } from '@aws-sdk/client-s3'

import type { S3Config } from './config.js'

export function createS3Client(config: S3Config): S3Client {
  // The AWS SDK's default credential chain handles auth resolution per spec
  // 018 §4.1 (env vars → IAM task role → instance profile → ~/.aws). We do
  // NOT pass `credentials` here so the chain stays intact; in LocalStack
  // dev/CI the env vars (AWS_ACCESS_KEY_ID / SECRET) win, in ECS prod the
  // task role wins.
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    // AWS SDK v3.729+ adds x-amz-checksum-* headers to PUT requests by
    // default ("WHEN_SUPPORTED"). LocalStack 3 rejects the CRC32 variant
    // with "InvalidRequest: x-amz-checksum-crc32 header is invalid". Real
    // S3 accepts it but it bloats the signed-PUT contract — browsers don't
    // send the checksum back, so the upload signature mismatches. Sticking
    // to "WHEN_REQUIRED" matches pre-v3.729 behaviour everywhere.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

/**
 * Spec 018 §3 — release the SDK's pooled HTTP handler so a graceful shutdown
 * doesn't hang on lingering sockets.
 */
export function closeS3Client(client: S3Client): void {
  client.destroy()
}
