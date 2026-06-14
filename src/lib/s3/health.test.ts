// Spec 018 §10.2 — HeadBucket probe.
//
// The 1s coalesce-cache behaviour lives in the shared `memoizeProbe` and is
// covered by `src/lib/health/probes.test.ts`. Here we test only what is
// specific to S3:
//   - HeadBucketCommand is the command actually sent (right bucket name)
//   - SDK rejections become `{ status: 'fail', error: <message> }`

import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'

import { createStorageProbe } from './health.js'

function makeClient(send: (cmd: unknown) => Promise<unknown>): S3Client {
  // Cast — only `send` is called by the probe.
  return { send } as unknown as S3Client
}

describe('createStorageProbe (spec 018 §10.2)', () => {
  it('sends a HeadBucketCommand against the configured bucket', async () => {
    const send = vi.fn().mockResolvedValue({})
    const probe = createStorageProbe({
      client: makeClient(send),
      bucket: 'my-bucket',
    })
    await probe()

    expect(send).toHaveBeenCalledTimes(1)
    const cmd = send.mock.calls[0]?.[0]
    expect(cmd).toBeInstanceOf(HeadBucketCommand)
    expect((cmd as HeadBucketCommand).input.Bucket).toBe('my-bucket')
  })

  it('returns status=ok with a non-negative latency on a resolved HeadBucket', async () => {
    const send = vi.fn().mockResolvedValue({})
    const probe = createStorageProbe({
      client: makeClient(send),
      bucket: 'my-bucket',
    })
    const r = await probe()
    expect(r.status).toBe('ok')
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('returns status=fail with the SDK error message when HeadBucket rejects', async () => {
    const send = vi.fn().mockRejectedValue(new Error('connection refused'))
    const probe = createStorageProbe({
      client: makeClient(send),
      bucket: 'my-bucket',
    })
    const r = await probe()
    expect(r.status).toBe('fail')
    expect(r.error).toMatch(/connection refused/)
  })
})
