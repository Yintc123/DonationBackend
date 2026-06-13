// Spec 004 — Logger module.
//
// Builds Fastify-compatible pino LoggerOptions from validated Config.
// Behaviour is driven entirely by the Config object (no process.env reads
// here — that's the env loader's job, spec 001).

import type { LoggerOptions } from 'pino'

import { REDACT_PATHS } from './redact.js'
import { errSerializer, reqSerializer, resSerializer } from './serializers.js'
import type { Config } from '../../config/schema.js'

export { loggerPolicyPlugin, shouldSkipRequestLog } from './policy.js'

export function createLogger(config: Config): LoggerOptions {
  const isDev = config.NODE_ENV === 'development'

  return {
    level: config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS },
    serializers: {
      req: reqSerializer,
      res: resSerializer,
      err: errSerializer,
    },
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, singleLine: true },
          },
        }
      : {}),
  }
}
