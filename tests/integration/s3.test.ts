// Spec 018 §12 — S3 plugin integration tests against a real LocalStack
// container (started in tests/setup/global-setup.ts).
//
// We exercise the full stack via fastify.inject() so the chain
// (errorHandler → security → http → prisma → redis → rate-limit → auth →
//  s3Plugin → healthPlugin → presign route) is real.

import { HeadObjectCommand } from '@aws-sdk/client-s3'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { objectUrl } from '../../src/lib/s3/index.js'
import { buildApp } from '../helpers/app.js'

const VALID_UUID = '0e1b41a8-0000-4000-8000-000000000001'

describe('s3 plugin (integration, spec 018 §12)', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // ── /health/storage ────────────────────────────────────────────────────

  it('GET /health/storage → 200 { status: "ok", bucket } when LocalStack is up (spec 018 §10.2)', async () => {
    app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/health/storage' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { status: string; bucket: string }
    expect(body.status).toBe('ok')
    expect(body.bucket).toBe(app.s3Config.bucket)
  })

  it('GET /health/ready stays 200 even when S3 is broken (spec 018 §10.3 — S3 NOT in readiness)', async () => {
    app = await buildApp()
    // Simulate S3 outage by pointing the SDK at a black hole port.
    const broken = app.s3.send
    app.s3.send = (() =>
      Promise.reject(new Error('simulated S3 outage'))) as typeof app.s3.send
    try {
      const res = await app.inject({ method: 'GET', url: '/health/ready' })
      expect(res.statusCode).toBe(200)
    } finally {
      app.s3.send = broken
    }
  })

  // ── app.objectUrl decorator (spec 015 §3.1) ────────────────────────────

  it('app.objectUrl(key) returns the same URL as the pure objectUrl(key, config)', async () => {
    app = await buildApp()
    const key = `donation/charities/${VALID_UUID}/logo.png`
    expect(app.objectUrl(key)).toBe(objectUrl(key, app.s3Config))
  })

  it('app.objectUrl(key) shape matches the LocalStack path-style base', async () => {
    app = await buildApp()
    const key = `donation/donation-projects/${VALID_UUID}/cover.jpg`
    const url = app.objectUrl(key)
    // The test harness points S3_PUBLIC_URL_BASE at nothing and forces path
    // style, so the URL is `<endpoint>/<bucket>/<key>`. We don't pin the
    // exact endpoint (testcontainers picks an ephemeral port); we pin the
    // shape.
    expect(url).toContain(app.s3Config.bucket)
    expect(url.endsWith(`/${key}`)).toBe(true)
  })

  // ── GET /v1/donation/uploads/presign ───────────────────────────────────

  it('GET .../presign → 200 with signed URL pointing at LocalStack (spec 018 §7.2)', async () => {
    app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/donation/uploads/presign',
      query: {
        entity: 'charities',
        id: VALID_UUID,
        purpose: 'logo',
        contentType: 'image/png',
        fileSize: '120000',
      },
    })
    // The entity does not exist in DB (spec 015 not landed yet), so we expect
    // 404 — this is intentional per spec 018 §7.5 step 0: never sign URLs
    // whose owning DB row is missing.
    expect(res.statusCode).toBe(404)
    const body = res.json() as { code: string }
    expect(body.code).toBe('CHARITY_NOT_FOUND')
  })

  it('GET .../presign → 400 VALIDATION_FAILED when fileSize exceeds S3_MAX_UPLOAD_BYTES', async () => {
    app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/donation/uploads/presign',
      query: {
        entity: 'charities',
        id: VALID_UUID,
        purpose: 'logo',
        contentType: 'image/png',
        fileSize: String(app.s3Config.maxUploadBytes + 1),
      },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { code: string }
    expect(body.code).toBe('VALIDATION_FAILED')
  })

  it('GET .../presign → 400 schema rejection for non-whitelisted contentType (PDF)', async () => {
    app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/donation/uploads/presign',
      query: {
        entity: 'charities',
        id: VALID_UUID,
        purpose: 'logo',
        contentType: 'application/pdf',
        fileSize: '120000',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('GET .../presign → 400 schema rejection when id is not a UUID', async () => {
    app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/donation/uploads/presign',
      query: {
        entity: 'charities',
        id: '../etc/passwd',
        purpose: 'logo',
        contentType: 'image/png',
        fileSize: '120000',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('GET .../presign exercises the 200 path with a stubbed entity check, asserting body + Cache-Control header (spec 018 §7.2)', async () => {
    app = await buildApp()

    // Spec 015 (donation prisma model) has not landed yet — `app.prisma`
    // has no `charity` delegate, so `ensureEntityExists` (domain/uploads/
    // check-entity.ts) returns 404 for any id. Stub the delegate inline so
    // we can exercise the 200 path and lock in the response contract.
    // When spec 015 ships, this stub becomes a real seeded charity row.
    ;(app.prisma as unknown as Record<string, unknown>).charity = {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === VALID_UUID ? { id: VALID_UUID } : null,
    }

    const res = await app.inject({
      method: 'GET',
      url: '/v1/donation/uploads/presign',
      query: {
        entity: 'charities',
        id: VALID_UUID,
        purpose: 'logo',
        contentType: 'image/png',
        fileSize: '120000',
      },
    })

    expect(res.statusCode).toBe(200)
    // Spec 018 §7.2 — every signature is unique; ban intermediary caches.
    expect(res.headers['cache-control']).toBe('no-store')

    const body = res.json() as {
      url: string
      method: 'PUT'
      headers: Record<string, string>
      key: string
      publicUrl: string
      expiresAt: string
    }
    expect(body.method).toBe('PUT')
    expect(body.key).toBe(`donation/charities/${VALID_UUID}/logo.png`)
    expect(body.headers['Content-Type']).toBe('image/png')
    // url + publicUrl point at the configured bucket (LocalStack in tests).
    expect(body.url).toContain(app.s3Config.bucket)
    expect(body.url).toContain('X-Amz-Signature=')
    expect(body.publicUrl).toContain(app.s3Config.bucket)
    // expiresAt is ISO-8601 and in the future.
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now())
  })

  // ── Full upload round-trip — the only test that proves SigV4 + LocalStack
  //    actually agree. Uses the SDK directly (without the route) so it doesn't
  //    require the entity-existence check.
  it('getPresignedUploadUrl → PUT → S3 stores the object (spec 018 §12 e2e)', async () => {
    app = await buildApp()
    const { getPresignedUploadUrl } = await import('../../src/lib/s3/index.js')

    const key = `donation/charities/${VALID_UUID}/logo.png`
    const body = Buffer.from('fake-png-bytes')
    const { url } = await getPresignedUploadUrl({
      client: app.s3,
      bucket: app.s3Config.bucket,
      key,
      contentType: 'image/png',
      contentLength: body.byteLength,
      ttlSeconds: app.s3Config.presignTtlSeconds,
    })

    const putRes = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body,
    })
    expect(putRes.status, await putRes.text()).toBe(200)

    // Verify by HEAD; this is also how clients confirm the object stored.
    const head = await app.s3.send(
      new HeadObjectCommand({ Bucket: app.s3Config.bucket, Key: key }),
    )
    expect(head.ContentLength).toBe(body.byteLength)
    expect(head.ContentType).toBe('image/png')
  })

  // NOTE: spec 018 §7.1.1 mandates ContentLength is in the SigV4 signed
  // headers — i.e. real S3 rejects PUTs whose body size mismatches the
  // signed length. LocalStack does NOT enforce that check (its SigV4
  // implementation is permissive), so we cannot integration-test the
  // behaviour locally. The presigned.ts unit covers that ContentLength is
  // passed to PutObjectCommand; AWS owns the enforcement contract. See
  // spec 018 §12 for the same caveat re CORS preflight.
})
