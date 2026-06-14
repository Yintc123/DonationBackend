// Spec 018 §11.1 — S3 SDK error → AppError.
//
// We do NOT echo raw SDK messages to clients (they may leak ARNs / accountIds).
// The AppError carries the SDK error as `cause` so pino's errSerializer walks
// it in logs.

import { S3ServiceException } from '@aws-sdk/client-s3'

import { ErrorCode, InternalError, ServiceUnavailableError } from '../errors/index.js'
import type { AppError } from '../errors/index.js'

export function mapS3Error(err: unknown): AppError {
  if (err instanceof S3ServiceException) {
    switch (err.name) {
      case 'NoSuchBucket':
        return new InternalError({
          message: 'S3 bucket is misconfigured',
          code: ErrorCode.S3_BUCKET_MISCONFIGURED,
          cause: err,
        })
      case 'AccessDenied':
        return new InternalError({
          message: 'S3 access denied',
          code: ErrorCode.S3_ACCESS_DENIED,
          cause: err,
        })
      case 'TimeoutError':
        return new ServiceUnavailableError({
          message: 'S3 request timed out',
          code: ErrorCode.S3_TIMEOUT,
          cause: err,
        })
      case 'NetworkingError':
        return new ServiceUnavailableError({
          message: 'S3 is unreachable',
          code: ErrorCode.S3_UNREACHABLE,
          cause: err,
        })
      default:
        return new InternalError({
          message: 'S3 unknown error',
          code: ErrorCode.S3_UNKNOWN,
          cause: err,
        })
    }
  }
  return new InternalError({
    message: 'S3 unknown error',
    code: ErrorCode.S3_UNKNOWN,
    cause: err,
  })
}
