// Spec 018 §3 / §10 — Fastify S3 plugin.
//
// Responsibilities:
//   - resolveS3Config(app.config) — fail-fast on missing / inconsistent env
//   - Create the S3Client and decorate app.s3 / app.s3Config / app.s3HealthProbe
//   - Release the SDK's HTTP handler on onClose (spec 018 §3 / spec 011 §9)
//
// Health endpoint ownership: this plugin does NOT register `/health/storage`.
// That route lives in healthPlugin (lib/health/plugin.ts) which owns the
// entire `/health/*` URL prefix — keeping a single owner avoids monitoring
// teams having to walk several plugins to find every probe surface. We
// expose `app.s3HealthProbe` and healthPlugin wires the route.
//
// We do NOT eagerly contact S3 at registration time. HeadBucket on boot is
// tempting for fail-fast, but it would block backend deploys whenever S3 has
// a regional blip — and spec 018 §6 design principle #6 explicitly says S3
// outages must not stop the rest of the API serving. The /health/storage
// route surfaces unhealthiness; readiness deliberately does not.

import type { S3Client } from '@aws-sdk/client-s3'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

import { closeS3Client, createS3Client } from './client.js'
import { resolveS3Config, type S3Config } from './config.js'
import { createStorageProbe, type StorageProbeResult } from './health.js'

declare module 'fastify' {
  interface FastifyInstance {
    s3: S3Client
    s3Config: S3Config
    s3HealthProbe: () => Promise<StorageProbeResult>
  }
}

export const s3Plugin = fp(
  async (app: FastifyInstance) => {
    const log = app.log.child({ module: 'storage' })

    const s3Config = resolveS3Config(app.config)
    const client = createS3Client(s3Config)
    const probe = createStorageProbe({ client, bucket: s3Config.bucket })

    app.decorate('s3', client)
    app.decorate('s3Config', s3Config)
    app.decorate('s3HealthProbe', probe)

    log.info(
      {
        event: 'storage_initialised',
        bucket: s3Config.bucket,
        region: s3Config.region,
        endpoint: s3Config.endpoint ?? null,
        forcePathStyle: s3Config.forcePathStyle,
      },
      's3 client ready',
    )

    app.addHook('onClose', async () => {
      closeS3Client(client)
      log.info({ event: 'storage_closed' }, 's3 client closed')
    })
  },
  {
    name: 's3-plugin',
    fastify: '5.x',
  },
)
