// Regression for the 2026-06-16 deploy: `prisma db seed` failed in production
// with `Foreign key constraint violated: order_lines_charityId_fkey` because
// OrderLine (spec 021 §3) carries onDelete: Restrict FKs to Charity /
// DonationProject / SaleItem, but seed's clearDonationDomain didn't wipe
// orders first. Any subsequent deploy on a DB with orders present would
// fail the same way.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { buildApp } from '../helpers/app.js'
import { clearDonationDomain } from '../../prisma/seed.js'

let app: FastifyInstance

beforeEach(async () => {
  app = await buildApp()
})

afterEach(async () => {
  await app.close()
})

describe('clearDonationDomain', () => {
  it('should wipe donation tables even when order_lines reference them', async () => {
    const charity = await app.prisma.charity.create({
      data: { name: 'C', description: 'd' },
    })
    const project = await app.prisma.donationProject.create({
      data: { charityId: charity.id, name: 'P', description: 'd', content: 'c' },
    })
    const saleItem = await app.prisma.saleItem.create({
      data: {
        charityId: charity.id,
        name: 'S',
        description: 'd',
        content: 'c',
        priceTwd: 100,
      },
    })

    await app.prisma.order.create({
      data: {
        donorName: 'donor-charity',
        amountTwd: 100,
        lines: {
          create: {
            subjectType: 'CHARITY',
            charityId: charity.id,
            quantity: 1,
            unitPriceTwd: 100,
            subtotalTwd: 100,
            donationFrequency: 'ONE_TIME',
          },
        },
      },
    })
    await app.prisma.order.create({
      data: {
        donorName: 'donor-project',
        amountTwd: 100,
        lines: {
          create: {
            subjectType: 'DONATION_PROJECT',
            donationProjectId: project.id,
            quantity: 1,
            unitPriceTwd: 100,
            subtotalTwd: 100,
            donationFrequency: 'ONE_TIME',
          },
        },
      },
    })
    await app.prisma.order.create({
      data: {
        donorName: 'buyer',
        amountTwd: 100,
        lines: {
          create: {
            subjectType: 'SALE_ITEM',
            saleItemId: saleItem.id,
            quantity: 1,
            unitPriceTwd: 100,
            subtotalTwd: 100,
          },
        },
      },
    })

    await clearDonationDomain(app.prisma)

    expect(await app.prisma.charity.count()).toBe(0)
    expect(await app.prisma.donationProject.count()).toBe(0)
    expect(await app.prisma.saleItem.count()).toBe(0)
  })
})
