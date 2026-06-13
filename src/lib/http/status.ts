// Spec 009 §3.1 — Success HTTP Status Code dictionary.
//
// Only the success codes the spec enumerates live here. Error status codes
// belong to spec 005's error handler; do not extend this object with 4xx/5xx.
//
// Frozen so accidental writes at runtime throw in strict mode.

export const HttpStatus = Object.freeze({
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  NOT_MODIFIED: 304,
} as const)

export type HttpSuccessStatus = (typeof HttpStatus)[keyof typeof HttpStatus]
