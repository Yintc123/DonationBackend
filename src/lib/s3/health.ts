// Spec 018 §10 — S3 connectivity probe.
//
// HeadBucket is the lightest call that proves both connectivity AND the IAM
// role has at least `s3:HeadBucket` (§4.1.1). We wrap it with a 1s timeout
// and a 1s coalesce cache so high-frequency probes don't load S3 billing.
//
// Both `runWithTimeout` and `memoizeProbe` live in `lib/health/probes.ts`
// — they are the cross-cutting probe utilities for the whole service.
// Spec 018 §10.2.1 explicitly says "對齊 spec 011 §7.2": one implementation,
// one cache semantics.

import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3'

import { memoizeProbe, runWithTimeout, type ProbeStatus } from '../health/probes.js'

const PROBE_TIMEOUT_MS = 1000
const PROBE_CACHE_TTL_MS = 1000

export interface StorageProbeResult extends ProbeStatus {
  latencyMs: number
  /** Internal only — never echoed to clients. */
  error?: string
}

export interface StorageProbeDeps {
  client: S3Client
  bucket: string
  /** Injectable for tests; defaults to {@link Date.now}. */
  now?: () => number
}

async function probeStorage(deps: StorageProbeDeps): Promise<StorageProbeResult> {
  const now = deps.now ?? Date.now
  const start = now()
  try {
    await runWithTimeout(
      () => deps.client.send(new HeadBucketCommand({ Bucket: deps.bucket })),
      PROBE_TIMEOUT_MS,
      'storage',
    )
    return { status: 'ok', latencyMs: now() - start }
  } catch (err) {
    return {
      status: 'fail',
      latencyMs: now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Build a memoised storage probe. Concurrent probes share one HeadBucket
 * call (coalesce). Successful results cache for {@link PROBE_CACHE_TTL_MS};
 * failures re-probe immediately on the next call.
 */
export function createStorageProbe(
  deps: StorageProbeDeps,
): () => Promise<StorageProbeResult> {
  return memoizeProbe(() => probeStorage(deps), PROBE_CACHE_TTL_MS, deps.now)
}
