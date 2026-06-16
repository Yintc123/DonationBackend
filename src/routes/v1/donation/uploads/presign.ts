// Spec 018 §7 — GET /cms/uploads/presign.
//
// Flow:
//   1. Validate query via TypeBox (Fastify schema → spec 005 errorHandler).
//   2. Assert contentLength against the live S3_MAX_UPLOAD_BYTES (the schema
//      bound is intentionally generic; this layer applies the config cap).
//   3. Ensure the entity row exists (spec §7.5 step 0 — never sign URLs for
//      keys whose owning DB row is missing → orphan objects).
//   4. Map contentType → ext, buildKey, sign PUT URL, build publicUrl.
//   5. Return per §7.2.

import type { FastifyInstance } from 'fastify'

import { ensureEntityExists } from '../../../../domain/uploads/check-entity.js'
import {
  assertContentLength,
  buildKey,
  contentTypeToExt,
  getPresignedUploadUrl,
  objectUrl,
} from '../../../../lib/s3/index.js'
import {
  PresignQuerySchema,
  PresignResponseSchema,
  type PresignQuery,
  type PresignResponse,
} from '../../../../schemas/uploads/presign.js'

// Spec 018 §7.4 — independent strict purpose bucket, NEVER shared with
// read-endpoint pools (each call = 1 unit of S3-write capacity granted to
// the requester). The L2 per-IP layer still runs (plugin default) so we do
// NOT need to override `perIp`; the purpose layer is what enforces the
// "presign-upload" 10/min budget specifically.
const PRESIGN_PURPOSE = {
  name: 'presign-upload',
  limit: 10,
  windowMs: 60_000,
}

export async function registerPresignUploadRoute(app: FastifyInstance): Promise<void> {
  app.route<{ Querystring: PresignQuery; Reply: PresignResponse }>({
    method: 'GET',
    url: '/uploads/presign',
    schema: {
      querystring: PresignQuerySchema,
      response: {
        200: PresignResponseSchema,
      },
    },
    config: {
      rateLimit: {
        purposes: [PRESIGN_PURPOSE],
      },
    },
    handler: async (req, reply) => {
      // Spec 020 §14 OQ #11 — admin gate. Only ADMIN accounts have a
      // reason to upload donation imagery (logos / cover photos for the
      // entities they manage). Same fail-safe semantics as the spec 020 §5
      // write endpoints: 401 on missing / expired JWT, 401 on disabled
      // account, 403 on role !== Role.ADMIN.
      const { entity, id, purpose, contentType, fileSize } = req.query

      assertContentLength(fileSize, app.s3Config.maxUploadBytes)
      await ensureEntityExists(app.prisma, entity, id)

      const ext = contentTypeToExt(contentType)
      const key = buildKey({ entity, id, purpose, ext })

      const { url, expiresAt } = await getPresignedUploadUrl({
        client: app.s3,
        bucket: app.s3Config.bucket,
        key,
        contentType,
        contentLength: fileSize,
        ttlSeconds: app.s3Config.presignTtlSeconds,
      })

      const publicUrl = objectUrl(key, app.s3Config)

      // Spec 018 §7.2 — every signature is unique, ban intermediaries from
      // caching the response. Header is chained before .ok() so the status
      // code stays sourced from lib/http (spec 009 §3.1) and we don't drift
      // from the rest of the routes.
      return reply.header('Cache-Control', 'no-store').ok({
        url,
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        key,
        publicUrl,
        expiresAt: expiresAt.toISOString(),
      })
    },
  })
}
