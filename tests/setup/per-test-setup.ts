// Spec 013 §6.1 — per-test reset hooks.
//
// Implemented:
//   - FLUSHDB the test Redis instance (spec 006 §14.2)
//   - TRUNCATE Postgres tables (spec 003 + spec 013 §6.1)
//
// Connection info comes from globalSetup via inject() (see global-setup.ts).

import { PrismaClient } from '@prisma/client'
import { Redis } from 'ioredis'
import { afterAll, beforeEach, inject } from 'vitest'

// FK-safe order is enforced by RESTART IDENTITY CASCADE below — list order
// here is just for readability.
const TRUNCATE_TABLES = [
  // Auth domain (spec 007 / 008)
  'google_credentials',
  'password_credentials',
  'accounts',
  // Donation order domain (spec 021 v0.7)
  // Listed before charities/projects/sale_items because OrderLine has FK
  // Restrict to those tables — CASCADE handles dependency order even so,
  // listing first is just intent-signalling.
  'order_lines',
  'orders',
  // Donation domain (spec 015 v0.9)
  'sale_items',
  'donation_projects',
  'charity_categories',
  'charities',
  'categories',
]

let prisma: PrismaClient | undefined

function getPrisma(dbUrl: string): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({ datasourceUrl: dbUrl })
  }
  return prisma
}

beforeEach(async () => {
  const redisHost = inject('TEST_REDIS_HOST')
  const redisPort = inject('TEST_REDIS_PORT')
  if (redisHost && redisPort) {
    const client = new Redis({
      host: redisHost,
      port: Number(redisPort),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    })
    try {
      await client.connect()
      await client.flushdb()
    } finally {
      await client.quit()
    }
  }

  const dbUrl = inject('TEST_DATABASE_URL')
  if (dbUrl) {
    const p = getPrisma(dbUrl)
    const list = TRUNCATE_TABLES.map((t) => `"${t}"`).join(', ')
    await p.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
  }
})

afterAll(async () => {
  await prisma?.$disconnect()
  prisma = undefined
})
