// Spec 001 §4.3 — load + validate environment configuration.
//
// Why this lives outside src/app.ts: the logger (spec 004) needs the
// validated Config BEFORE Fastify is constructed so it can be passed
// into `Fastify({ logger: createLogger(config) })`. @fastify/env runs
// post-construction, which would force a two-phase bootstrap. Loading
// here gives us a single source of truth for both the logger and the
// app.config decoration in buildApp().

import { config as dotenvLoad } from 'dotenv'
import { expand as dotenvExpand } from 'dotenv-expand'
import { Ajv, type ErrorObject } from 'ajv'

import { ConfigSchema, type Config } from './schema.js'
import { postValidate } from './post-validate.js'

const ajv = new Ajv({
  coerceTypes: true,
  useDefaults: true,
  allErrors: true,
  removeAdditional: 'all',
})

const validateSchema = ajv.compile(ConfigSchema)

export class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigLoadError'
  }
}

export interface LoadConfigOptions {
  /** When true, read .env from disk (default). Tests inject via process.env. */
  readDotenv?: boolean
}

export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const readDotenv = opts.readDotenv ?? true

  if (readDotenv) {
    const loaded = dotenvLoad({ quiet: true })
    dotenvExpand(loaded)
  }

  // ajv mutates the input object when applying defaults / coercions, so work
  // on a shallow copy of process.env (only the string-valued slice).
  const candidate: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') candidate[k] = v
  }

  if (!validateSchema(candidate)) {
    const errors = (validateSchema.errors ?? [])
      .map((e: ErrorObject) => `  - ${e.instancePath || '/'} ${e.message ?? 'invalid'}`)
      .join('\n')
    throw new ConfigLoadError(
      `Environment validation failed (spec 001 §4.3):\n${errors}`,
    )
  }

  const config = candidate as unknown as Config
  postValidate(config)
  return config
}
