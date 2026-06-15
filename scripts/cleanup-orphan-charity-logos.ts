// Spec 015 v0.8 — one-shot cleanup of orphan 1×1 placeholder PNGs left under
// `donation/charities/` after the seed switched from "every charity gets a
// placeholder" to "only the featured charity gets a real logo".
//
// Identification: 1×1 PNG placeholders are ~100 bytes; the featured-charity
// placeholder (frontend/public/figma/charity-placeholder.png, ~160 KB) is
// orders of magnitude larger. So filtering `Size < 200` byte-perfectly keeps
// the new real logo and drops every legacy placeholder.
//
// IAM:
//   The backend ECS execution role deliberately does NOT have DeleteObject
//   (spec 018 §5 — least privilege). Run this script LOCALLY with credentials
//   that hold s3:ListBucket + s3:DeleteObject.
//
// Usage:
//   # Prod (uses default AWS profile, real bucket):
//   AWS_PROFILE=admin S3_BUCKET=jko-donation-prod \
//     npx tsx scripts/cleanup-orphan-charity-logos.ts
//
//   # Dry-run (preview only, no deletion):
//   AWS_PROFILE=admin S3_BUCKET=jko-donation-prod DRY_RUN=1 \
//     npx tsx scripts/cleanup-orphan-charity-logos.ts
//
//   # LocalStack (verify the script logic without touching prod):
//   AWS_ENDPOINT_URL=http://localhost:4566 \
//   AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
//   AWS_REGION=ap-northeast-1 S3_BUCKET=local-dev-assets DRY_RUN=1 \
//     npx tsx scripts/cleanup-orphan-charity-logos.ts

import { createInterface } from 'node:readline/promises'

import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object,
} from '@aws-sdk/client-s3'

const PREFIX = 'donation/charities/'
const SIZE_THRESHOLD_BYTES = 200

function envRequired(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing env: ${name}`)
  return v
}

async function listOrphans(s3: S3Client, bucket: string): Promise<_Object[]> {
  const orphans: _Object[] = []
  let continuationToken: string | undefined

  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: PREFIX,
        ContinuationToken: continuationToken,
      }),
    )
    for (const obj of res.Contents ?? []) {
      if (obj.Key && (obj.Size ?? 0) < SIZE_THRESHOLD_BYTES) {
        orphans.push(obj)
      }
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (continuationToken)

  return orphans
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(prompt)
    return answer.trim().toLowerCase() === 'y'
  } finally {
    rl.close()
  }
}

async function main(): Promise<void> {
  const bucket = envRequired('S3_BUCKET')
  const dryRun = process.env.DRY_RUN === '1'

  // AWS SDK auto-resolves region + creds from env / shared config / IMDS.
  // AWS_ENDPOINT_URL is read EXPLICITLY because some SDK builds skip auto-
  // resolution for it. forcePathStyle is required when pointing at LocalStack
  // (no virtual-host bucket addressing); prod uses the default.
  const endpoint = process.env.AWS_ENDPOINT_URL
  const s3 = new S3Client({
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  })

  console.log(`→ listing s3://${bucket}/${PREFIX} with Size < ${SIZE_THRESHOLD_BYTES.toString()} bytes …`)
  const orphans = await listOrphans(s3, bucket)

  if (orphans.length === 0) {
    console.log('✓ no orphan placeholders found — nothing to do')
    return
  }

  console.log(`→ ${orphans.length.toString()} candidate object(s):`)
  for (const o of orphans) {
    console.log(`    ${o.Key ?? ''}  (${(o.Size ?? 0).toString()} bytes)`)
  }

  if (dryRun) {
    console.log('(DRY_RUN=1 — exiting without deletion)')
    return
  }

  const proceed = await confirm(
    `delete the ${orphans.length.toString()} object(s) above? [y/N] `,
  )
  if (!proceed) {
    console.log('aborted')
    return
  }

  for (const o of orphans) {
    if (!o.Key) continue
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key }))
    console.log(`  ✓ deleted ${o.Key}`)
  }
  console.log(`✓ removed ${orphans.length.toString()} orphan placeholder(s)`)
}

main().catch((err: unknown) => {
  console.error('cleanup failed:', err)
  process.exit(1)
})
