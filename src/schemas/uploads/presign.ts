// Spec 018 §7.1 / §7.2 — TypeBox shapes for GET /v1/donation/uploads/presign.

import { Type, type Static } from '@sinclair/typebox'

import {
  ALLOWED_CONTENT_TYPES,
  ENTITIES,
  PURPOSES,
} from '../../lib/s3/index.js'

const UUID_V4_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

export const PresignQuerySchema = Type.Object({
  entity: Type.Union(ENTITIES.map((e) => Type.Literal(e))),
  id: Type.String({ pattern: UUID_V4_PATTERN, minLength: 36, maxLength: 36 }),
  purpose: Type.Union(PURPOSES.map((p) => Type.Literal(p))),
  contentType: Type.Union(ALLOWED_CONTENT_TYPES.map((c) => Type.Literal(c))),
  // Spec 018 §7.1 — fileSize is required and bounded by S3_MAX_UPLOAD_BYTES
  // (additionally enforced by assertContentLength against the live config).
  fileSize: Type.Integer({ minimum: 1 }),
})

export type PresignQuery = Static<typeof PresignQuerySchema>

export const PresignHeadersSchema = Type.Object({
  'Content-Type': Type.String(),
})

export const PresignResponseSchema = Type.Object({
  url: Type.String({ format: 'uri' }),
  method: Type.Literal('PUT'),
  headers: PresignHeadersSchema,
  key: Type.String({ minLength: 1 }),
  publicUrl: Type.String({ format: 'uri' }),
  expiresAt: Type.String({ format: 'date-time' }),
})

export type PresignResponse = Static<typeof PresignResponseSchema>
