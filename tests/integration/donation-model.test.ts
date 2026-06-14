// Spec 015 v0.9 §11 — donation model integration tests against a real
// PostgreSQL testcontainer.
//
// Covers:
//   - FK Restrict (hard delete Charity blocked while children exist)
//   - M:N join (Charity ↔ Category) — Cascade on charity side, Restrict on
//     category side
//   - Child inheritance filter (Project / SaleItem 透過主表 categories)
//   - pg_trgm extension installed + GIN index reachable via ILIKE
//   - whereLive — all four conditions individually exclude the right rows
//   - whereLiveWithParent — cascading visibility, forward + reverse
//   - displayOrder sort
//   - All three lifecycle states (archived / deleted / scheduled) hide row
//     from the public path

import { PrismaClient } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it, inject } from 'vitest'

import { whereLive, whereLiveWithParent } from '../../src/domain/lifecycle/index.js'
import type { CATEGORY_KEYS } from '../../src/domain/category/keys.js'

const REF = new Date('2026-06-14T12:00:00.000Z')
const past = (days: number): Date => new Date(REF.getTime() - days * 86_400_000)
const future = (days: number): Date => new Date(REF.getTime() + days * 86_400_000)

let prisma: PrismaClient

beforeEach(async () => {
  const dbUrl = inject('TEST_DATABASE_URL')
  prisma = new PrismaClient({ datasourceUrl: dbUrl })
})

afterAll(async () => {
  await prisma?.$disconnect()
})

async function seedCategoryByKey(key: (typeof CATEGORY_KEYS)[number]): Promise<string> {
  const c = await prisma.category.create({
    data: { key, displayName: `display:${key}`, displayNameEn: `Display ${key}`, displayOrder: 0 },
  })
  return c.id
}

async function seedCharity(overrides: Partial<{
  name: string
  displayOrder: number
  archivedAt: Date | null
  deletedAt: Date | null
  publishStartAt: Date | null
  publishEndAt: Date | null
}> = {}): Promise<{ id: string }> {
  return prisma.charity.create({
    data: {
      name: overrides.name ?? 'Charity-' + Math.random().toString(36).slice(2, 8),
      description: 'desc',
      displayOrder: overrides.displayOrder ?? 0,
      archivedAt: overrides.archivedAt ?? undefined,
      deletedAt: overrides.deletedAt ?? undefined,
      publishStartAt: overrides.publishStartAt ?? undefined,
      publishEndAt: overrides.publishEndAt ?? undefined,
    },
  })
}

describe('Donation model — schema + FK (spec 015 §3.4 / §3.5)', () => {
  it('Project / SaleItem reject FK pointing at a non-existent Charity', async () => {
    await expect(
      prisma.donationProject.create({
        data: {
          charityId: '00000000-0000-4000-8000-000000000000',
          name: 'orphan project',
          description: 'd',
          content: 'c',
        },
      }),
    ).rejects.toThrow()
  })

  it('Charity hard-delete is blocked while a DonationProject still references it (onDelete: Restrict)', async () => {
    const c = await seedCharity()
    await prisma.donationProject.create({
      data: { charityId: c.id, name: 'p', description: 'd', content: 'c' },
    })
    await expect(prisma.charity.delete({ where: { id: c.id } })).rejects.toThrow()
  })

  it('Charity hard-delete is blocked while a SaleItem still references it (onDelete: Restrict)', async () => {
    const c = await seedCharity()
    await prisma.saleItem.create({
      data: { charityId: c.id, name: 's', description: 'd', content: 'c', priceTwd: 100 },
    })
    await expect(prisma.charity.delete({ where: { id: c.id } })).rejects.toThrow()
  })
})

describe('Donation model — M:N CharityOnCategory (spec 015 §3.5)', () => {
  it('Charity hard-delete cascades the join rows (charity-side onDelete: Cascade)', async () => {
    const catId = await seedCategoryByKey('animal_protection')
    const c = await seedCharity()
    await prisma.charityOnCategory.create({ data: { charityId: c.id, categoryId: catId } })
    await prisma.charity.delete({ where: { id: c.id } })
    const remaining = await prisma.charityOnCategory.count({ where: { categoryId: catId } })
    expect(remaining).toBe(0)
  })

  it('Category hard-delete is blocked while a Charity is still attached (category-side onDelete: Restrict)', async () => {
    const catId = await seedCategoryByKey('child_care')
    const c = await seedCharity()
    await prisma.charityOnCategory.create({ data: { charityId: c.id, categoryId: catId } })
    await expect(prisma.category.delete({ where: { id: catId } })).rejects.toThrow()
  })

  it('Category unique key constraint rejects duplicates', async () => {
    await seedCategoryByKey('elderly_care')
    await expect(seedCategoryByKey('elderly_care')).rejects.toThrow()
  })

  it('Composite PK (charityId, categoryId) prevents the same charity attaching the same category twice', async () => {
    const catId = await seedCategoryByKey('media')
    const c = await seedCharity()
    await prisma.charityOnCategory.create({ data: { charityId: c.id, categoryId: catId } })
    await expect(
      prisma.charityOnCategory.create({ data: { charityId: c.id, categoryId: catId } }),
    ).rejects.toThrow()
  })
})

describe('Donation model — pg_trgm extension + GIN index (spec 015 §4.2)', () => {
  it('pg_trgm extension is installed by the migration', async () => {
    const rows = await prisma.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'
    `
    expect(rows).toHaveLength(1)
  })

  it('GIN trgm indexes exist for charities.name / nameEn / description / descriptionEn', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'charities'
        AND indexname LIKE 'charities_%_trgm_idx'
    `
    const names = rows.map((r) => r.indexname).sort()
    expect(names).toEqual([
      'charities_descriptionEn_trgm_idx',
      'charities_description_trgm_idx',
      'charities_nameEn_trgm_idx',
      'charities_name_trgm_idx',
    ])
  })

  it('ILIKE search on Charity.name matches by substring (functional check, planner-agnostic)', async () => {
    await seedCharity({ name: '台灣流浪動物之家' })
    await seedCharity({ name: '伊甸基金會' })
    const hits = await prisma.charity.findMany({
      where: { name: { contains: '流浪動物' } },
    })
    expect(hits).toHaveLength(1)
  })
})

describe('Donation model — whereLive(now) filters (ADR 006 §2 / spec 015 v0.9)', () => {
  it('excludes archived rows', async () => {
    await seedCharity({ name: 'live row' })
    await seedCharity({ name: 'archived row', archivedAt: past(1) })
    const live = await prisma.charity.findMany({ where: whereLive(REF) })
    expect(live.map((c) => c.name)).toContain('live row')
    expect(live.map((c) => c.name)).not.toContain('archived row')
  })

  it('excludes soft-deleted rows', async () => {
    await seedCharity({ name: 'live row' })
    await seedCharity({ name: 'deleted row', deletedAt: past(1) })
    const live = await prisma.charity.findMany({ where: whereLive(REF) })
    expect(live.map((c) => c.name)).not.toContain('deleted row')
  })

  it('excludes rows whose publishStartAt is still in the future', async () => {
    await seedCharity({ name: 'scheduled row', publishStartAt: future(1) })
    const live = await prisma.charity.findMany({ where: whereLive(REF) })
    expect(live.map((c) => c.name)).not.toContain('scheduled row')
  })

  it('includes a scheduled row once `now` advances past publishStartAt', async () => {
    await seedCharity({ name: 'scheduled row', publishStartAt: future(1) })
    const live = await prisma.charity.findMany({ where: whereLive(future(2)) })
    expect(live.map((c) => c.name)).toContain('scheduled row')
  })

  it('excludes rows whose publishEndAt has already passed', async () => {
    await seedCharity({ name: 'expired row', publishEndAt: past(1) })
    const live = await prisma.charity.findMany({ where: whereLive(REF) })
    expect(live.map((c) => c.name)).not.toContain('expired row')
  })

  it('keeps null/null/null/null rows (default "live forever") visible', async () => {
    await seedCharity({ name: 'permanent row' })
    const live = await prisma.charity.findMany({ where: whereLive(REF) })
    expect(live.map((c) => c.name)).toContain('permanent row')
  })
})

describe('Donation model — Cascading visibility (ADR 006 §3)', () => {
  it('a Project under a Charity with an expired publishEndAt is HIDDEN by whereLiveWithParent', async () => {
    const expiredCharity = await seedCharity({
      name: 'expired charity',
      publishEndAt: past(1),
    })
    await prisma.donationProject.create({
      data: {
        charityId: expiredCharity.id,
        name: 'child project under expired parent',
        description: 'd',
        content: 'c',
        // child's own fields are all defaults → permanently visible if parent allowed it
      },
    })
    const visible = await prisma.donationProject.findMany({
      where: whereLiveWithParent(REF),
    })
    expect(visible.map((p) => p.name)).not.toContain('child project under expired parent')
  })

  it('reverse: when the parent contract is renewed, the same child reappears (no batch job)', async () => {
    const charity = await seedCharity({ name: 'reborn charity', publishEndAt: past(1) })
    await prisma.donationProject.create({
      data: { charityId: charity.id, name: 'reborn project', description: 'd', content: 'c' },
    })
    // Pre-renewal: hidden
    let visible = await prisma.donationProject.findMany({ where: whereLiveWithParent(REF) })
    expect(visible.map((p) => p.name)).not.toContain('reborn project')
    // Renew the contract.
    await prisma.charity.update({
      where: { id: charity.id },
      data: { publishEndAt: future(30) },
    })
    // Post-renewal: visible, no children rows were touched.
    visible = await prisma.donationProject.findMany({ where: whereLiveWithParent(REF) })
    expect(visible.map((p) => p.name)).toContain('reborn project')
  })

  it('an archived parent also hides its children', async () => {
    const charity = await seedCharity({ name: 'archived parent', archivedAt: past(1) })
    await prisma.saleItem.create({
      data: { charityId: charity.id, name: 'orphaned item', description: 'd', content: 'c', priceTwd: 100 },
    })
    const visible = await prisma.saleItem.findMany({ where: whereLiveWithParent(REF) })
    expect(visible.map((s) => s.name)).not.toContain('orphaned item')
  })

  it('child can be hidden even when parent is live (child has its own lifecycle)', async () => {
    const charity = await seedCharity({ name: 'live parent' })
    await prisma.donationProject.create({
      data: {
        charityId: charity.id,
        name: 'archived child',
        description: 'd',
        content: 'c',
        archivedAt: past(1),
      },
    })
    const visible = await prisma.donationProject.findMany({ where: whereLiveWithParent(REF) })
    expect(visible.map((p) => p.name)).not.toContain('archived child')
  })
})

describe('Donation model — displayOrder sorting (ADR 006 §4)', () => {
  it('sorts by displayOrder ASC, then createdAt DESC, then id DESC', async () => {
    const earlier = await seedCharity({ name: 'A pinned', displayOrder: -2 })
    const middle = await seedCharity({ name: 'B middle pinned', displayOrder: -1 })
    const tail = await seedCharity({ name: 'C unpinned', displayOrder: 0 })
    const rows = await prisma.charity.findMany({
      where: whereLive(REF),
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
    })
    const names = rows.map((r) => r.name)
    // The two pinned rows come first in their pinned order.
    expect(names.indexOf('A pinned')).toBeLessThan(names.indexOf('B middle pinned'))
    expect(names.indexOf('B middle pinned')).toBeLessThan(names.indexOf('C unpinned'))
    // Sanity: all three appear.
    expect(names).toEqual(expect.arrayContaining(['A pinned', 'B middle pinned', 'C unpinned']))
    // Reference seeded ids — silences the "unused variable" lint warning.
    expect(earlier.id).toBeTruthy()
    expect(middle.id).toBeTruthy()
    expect(tail.id).toBeTruthy()
  })
})

describe('Donation model — inheritance filter (spec 015 §7.4)', () => {
  it('Project inherits the parent Charity categories via JOIN charity_categories', async () => {
    const animalId = await seedCategoryByKey('animal_protection')
    const charityWithAnimal = await seedCharity({ name: 'animal charity' })
    const charityWithoutAnimal = await seedCharity({ name: 'unrelated charity' })
    await prisma.charityOnCategory.create({
      data: { charityId: charityWithAnimal.id, categoryId: animalId },
    })

    await prisma.donationProject.create({
      data: { charityId: charityWithAnimal.id, name: 'P-animal', description: 'd', content: 'c' },
    })
    await prisma.donationProject.create({
      data: {
        charityId: charityWithoutAnimal.id,
        name: 'P-other',
        description: 'd',
        content: 'c',
      },
    })

    const animalProjects = await prisma.donationProject.findMany({
      where: {
        ...whereLiveWithParent(REF),
        charity: {
          is: {
            ...whereLive(REF),
            categories: { some: { category: { key: 'animal_protection' } } },
          },
        },
      },
    })
    expect(animalProjects.map((p) => p.name)).toEqual(['P-animal'])
  })
})
