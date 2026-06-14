// Spec 015 §6 — Donation domain seeder entry.
//
// Idempotent: deletes the donation domain rows first (in FK-safe order),
// then re-creates from the per-table seed scripts. We do NOT touch
// accounts / credentials (spec 007 / 008 owns those).
//
// S3 placeholder images:
//   For every row that declares hasLogo / hasCover, the seed scripts call
//   `uploadAsset(key)` which puts a 1×1 PNG to LocalStack (or real S3 — same
//   API). The image bytes are placeholder; UI just needs a non-404 URL.

import { PutObjectCommand } from '@aws-sdk/client-s3'
import { PrismaClient } from '@prisma/client'

import { loadConfig } from '../src/config/load.js'
import { composeDatabaseUrl } from '../src/lib/db/compose-database-url.js'
import {
  createS3Client,
  resolveS3Config,
  type S3Config,
} from '../src/lib/s3/index.js'

import { seedCategories } from './seed/categories.js'
import { seedCharities } from './seed/charities.js'
import { seedDonationProjects } from './seed/donation-projects.js'
import { seedSaleItems } from './seed/sale-items.js'

// 1×1 transparent PNG — smallest valid PNG, plenty for a placeholder.
const PLACEHOLDER_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cf' +
    'c0c000000003000100' +
    '5b6c2a5d0000000049454e44ae426082',
  'hex',
)

// 1×1 JPEG (minimal, ~125 bytes).
const PLACEHOLDER_JPG = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c19' +
    '1212131720dca0606081d292e3a504a464e424d4c4d4e4548d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2' +
    'd2d2d2d2d2d2d2ffc00011080001000103012200021101031101ffc4001f0000010501010101010100000000000000' +
    '000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613' +
    '516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a4344' +
    '45464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798' +
    '999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7' +
    'e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbfcffd9',
  'hex',
)

async function uploadPlaceholder(
  put: (key: string, body: Buffer, contentType: string) => Promise<void>,
  key: string,
): Promise<void> {
  if (key.endsWith('.png')) await put(key, PLACEHOLDER_PNG, 'image/png')
  else if (key.endsWith('.jpg') || key.endsWith('.jpeg'))
    await put(key, PLACEHOLDER_JPG, 'image/jpeg')
  else throw new Error(`seed: unsupported placeholder extension for key ${key}`)
}

async function main(): Promise<void> {
  const config = loadConfig({ readDotenv: true })
  const prisma = new PrismaClient({ datasourceUrl: composeDatabaseUrl(config) })
  const s3Config: S3Config = resolveS3Config(config)
  const s3 = createS3Client(s3Config)

  const put = async (key: string, body: Buffer, contentType: string): Promise<void> => {
    await s3.send(
      new PutObjectCommand({
        Bucket: s3Config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      }),
    )
  }
  const uploadAsset = (key: string): Promise<void> => uploadPlaceholder(put, key)

  try {
    // FK-safe truncate order: sale_items + donation_projects (children) →
    // charity_categories (M:N) → charities → categories.
    // We use deleteMany (idempotent per row) rather than TRUNCATE because we
    // need to coexist with accounts tables that the seed doesn't touch.
    console.log('→ clearing donation domain tables')
    await prisma.saleItem.deleteMany({})
    await prisma.donationProject.deleteMany({})
    await prisma.charityOnCategory.deleteMany({})
    await prisma.charity.deleteMany({})
    await prisma.category.deleteMany({})

    console.log('→ seeding 16 categories')
    const categoryIdByKey = await seedCategories(prisma)

    console.log(`→ seeding charities (and uploading placeholder logos to ${s3Config.bucket})`)
    const charities = await seedCharities(prisma, categoryIdByKey, uploadAsset)

    console.log(`→ seeding donation projects under ${charities.length.toString()} charities`)
    await seedDonationProjects(prisma, charities, uploadAsset)

    console.log(`→ seeding sale items`)
    await seedSaleItems(prisma, charities, uploadAsset)

    // Post-condition checks (spec 015 §6.4 — verify constraints).
    // `completeCharities` enforces the 9-field bar set on 2026-06-14: every
    // UI / i18n / IMG_4876 compliance field non-null AND no lifecycle dates.
    // If this drops below 30 the seed surface has lost coverage and the demo
    // detail page will start showing holes.
    const completeCharities = await prisma.charity.count({
      where: {
        nameEn: { not: null },
        descriptionEn: { not: null },
        logoKey: { not: null },
        contactPhone: { not: null },
        contactEmail: { not: null },
        officialWebsite: { not: null },
        approvalNo: { not: null },
        archivedAt: null,
        deletedAt: null,
      },
    })
    const counts = {
      categories: await prisma.category.count(),
      charities: await prisma.charity.count(),
      completeCharities,
      donationProjects: await prisma.donationProject.count(),
      saleItems: await prisma.saleItem.count(),
      charityCategories: await prisma.charityOnCategory.count(),
    }
    console.log('→ counts:', counts)

    if (counts.categories !== 16) throw new Error('seed post-condition: need 16 categories')
    if (counts.charities < 30) throw new Error('seed post-condition: need ≥ 30 charities')
    if (counts.completeCharities < 30)
      throw new Error('seed post-condition: need ≥ 30 fully-populated charities')
    if (counts.donationProjects < 49)
      throw new Error('seed post-condition: need ≥ 49 donation projects')
    if (counts.saleItems < 49) throw new Error('seed post-condition: need ≥ 49 sale items')

    console.log('✓ seed complete')
  } finally {
    s3.destroy()
    await prisma.$disconnect()
  }
}

main().catch((err: unknown) => {
  console.error('seed failed:', err)
  process.exit(1)
})
