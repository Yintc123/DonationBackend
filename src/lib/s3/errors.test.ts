// Spec 018 §11.1 — map S3 SDK errors onto AppError.

import { S3ServiceException } from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'

import { ErrorCode } from '../errors/index.js'

import { mapS3Error } from './errors.js'

function makeException(name: string): S3ServiceException {
  return new S3ServiceException({
    name,
    message: name,
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  })
}

describe('mapS3Error (spec 018 §11.1)', () => {
  it('NoSuchBucket → InternalError code S3_BUCKET_MISCONFIGURED', () => {
    const e = mapS3Error(makeException('NoSuchBucket'))
    expect(e.statusCode).toBe(500)
    expect(e.code).toBe(ErrorCode.S3_BUCKET_MISCONFIGURED)
  })

  it('AccessDenied → InternalError code S3_ACCESS_DENIED', () => {
    const e = mapS3Error(makeException('AccessDenied'))
    expect(e.statusCode).toBe(500)
    expect(e.code).toBe(ErrorCode.S3_ACCESS_DENIED)
  })

  it('TimeoutError → ServiceUnavailableError code S3_TIMEOUT', () => {
    const e = mapS3Error(makeException('TimeoutError'))
    expect(e.statusCode).toBe(503)
    expect(e.code).toBe(ErrorCode.S3_TIMEOUT)
  })

  it('NetworkingError → ServiceUnavailableError code S3_UNREACHABLE', () => {
    const e = mapS3Error(makeException('NetworkingError'))
    expect(e.statusCode).toBe(503)
    expect(e.code).toBe(ErrorCode.S3_UNREACHABLE)
  })

  it('unknown S3 exception → InternalError code S3_UNKNOWN', () => {
    const e = mapS3Error(makeException('SomethingNew'))
    expect(e.statusCode).toBe(500)
    expect(e.code).toBe(ErrorCode.S3_UNKNOWN)
  })

  it('non-S3 error → InternalError code S3_UNKNOWN with cause', () => {
    const raw = new Error('socket hangup')
    const e = mapS3Error(raw)
    expect(e.statusCode).toBe(500)
    expect(e.code).toBe(ErrorCode.S3_UNKNOWN)
    expect((e as Error).cause).toBe(raw)
  })
})
