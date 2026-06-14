// Spec 005 — public surface of the error handling module.
//
// Consumers import from this barrel so internal layout can evolve without
// breaking callers (mirrors src/lib/http/index.ts convention).

export {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  GatewayTimeoutError,
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  UnprocessableEntityError,
  UnsupportedMediaTypeError,
  ValidationError,
  type AppErrorOptions,
  type ErrorDetails,
  type ValidationErrorItem,
} from './AppError.js'
export { ErrorCode, ErrorCodeStatus, type ErrorCodeValue } from './codes.js'
export { default as errorHandlerPlugin, type ErrorHandlerOptions } from './plugin.js'
export { mapPrismaError } from './prisma.js'
export { toProblem, type ProblemBody, type ProblemContext } from './problem.js'
