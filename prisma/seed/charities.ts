// Spec 015 §6.4 — Charity seed.
//
// Coverage requirements (verified by the seed entry post-conditions):
//   - ≥ 20 charities
//   - 1 full-contact row (IMG_4876 baseline)
//   - ≥ 30% nameEn / descriptionEn backfilled
//   - ≥ 1 stray-or-animal english backfill row (for `q=stray` demo)
//   - ≥ 1 zh row with "流浪動物" in name/desc
//   - ≥ 2 charities tagged animal_protection
//   - 1-2 archived demos
//   - 1 deleted demo
//   - 1 cascade demo (publishEndAt in the past)
//   - 2-3 displayOrder-pinned rows (negative numbers)
//   - assignCategory: 1-3 categories per charity

import type { PrismaClient } from '@prisma/client'

import { buildKey } from '../../src/lib/s3/index.js'

import type { CategoryKey } from '../../src/domain/category/keys.js'

interface CharitySeed {
  name: string
  description: string
  nameEn?: string
  descriptionEn?: string
  hasLogo?: boolean
  contactPhone?: string
  contactEmail?: string
  officialWebsite?: string
  approvalNo?: string
  displayOrder?: number
  archivedAt?: Date
  deletedAt?: Date
  publishStartAt?: Date
  publishEndAt?: Date
  categoryKeys: CategoryKey[]
}

const REF = new Date('2026-06-14T12:00:00.000Z')
const past = (days: number): Date => new Date(REF.getTime() - days * 86_400_000)

// 22 entries — keep names distinct (UI prefers visual variety) but allow
// repeats in the wider seed; the production model doesn't enforce unique
// names (spec 015 §3.3).
const CHARITIES: readonly CharitySeed[] = [
  // Pinned / featured — displayOrder negative.
  {
    name: 'ACC 中華耆幼關懷協會',
    description: '當你長大時,你會發現你有兩隻手,一隻用來幫助自己,一隻來幫助別人。我們陪伴老人,也陪伴孩子。',
    nameEn: 'ACC Chinese Elder & Youth Care Association',
    descriptionEn: 'Walking with the elderly and the young — a hand for yourself, a hand for others.',
    hasLogo: true,
    contactPhone: '02-66040024',
    contactEmail: 'serv.accofroc@gmail.com',
    officialWebsite: 'https://accofroc.org',
    approvalNo: '台內團字第1110295700號',
    displayOrder: -2,
    categoryKeys: ['child_care', 'elderly_care', 'poverty_relief'],
  },
  {
    name: '台灣流浪動物之家基金會',
    description: '收容無家可歸的犬貓,推動以領養代替購買、結紮代替撲殺。',
    nameEn: 'Taiwan Stray Animal Sanctuary Foundation',
    descriptionEn: 'Sheltering stray dogs and cats; adopt, do not shop.',
    hasLogo: true,
    displayOrder: -1,
    categoryKeys: ['animal_protection'],
  },
  // 常規 row — 多數預設「永久上架」(全部 publish 欄位 null)。
  {
    name: '中華民國動物福利促進協會',
    description: '推動流浪動物 TNR(誘捕、結紮、回置)與動物福利立法。',
    nameEn: 'Animal Welfare Promotion Association',
    descriptionEn: 'Promoting TNR for stray animals and welfare legislation.',
    hasLogo: true,
    categoryKeys: ['animal_protection', 'public_issue'],
  },
  {
    name: '台灣世界展望會',
    description: '長期關懷貧困兒童、推動社區發展、緊急人道救援。',
    hasLogo: true,
    categoryKeys: ['child_care', 'international_aid', 'poverty_relief'],
  },
  {
    name: '台灣兒童暨家庭扶助基金會',
    description: '陪伴經濟弱勢家庭與兒少,提供家庭支持、教育補助與心理輔導。',
    nameEn: 'Taiwan Fund for Children and Families',
    descriptionEn: 'Supporting families in economic hardship with mentorship and education.',
    hasLogo: true,
    categoryKeys: ['child_care', 'poverty_relief'],
  },
  {
    name: '伊甸社會福利基金會',
    description: '服務身心障礙者家庭、推動無障礙環境與職業重建。',
    hasLogo: true,
    categoryKeys: ['disability_service', 'community_development'],
  },
  {
    name: '創世社會福利基金會',
    description: '照顧植物人與貧苦長者,推動社區安寧。',
    hasLogo: true,
    categoryKeys: ['elderly_care', 'special_medical'],
  },
  {
    name: '陽光社會福利基金會',
    description: '陪伴顏面損傷與燒傷者重返社會。',
    hasLogo: true,
    categoryKeys: ['special_medical', 'disability_service'],
  },
  {
    name: '台灣勵馨基金會',
    description: '陪伴遭受性別暴力的婦女與青少女,倡議性別正義。',
    hasLogo: true,
    categoryKeys: ['women_care', 'public_issue'],
  },
  {
    name: '台灣家扶基金會',
    description: '深耕弱勢家庭與兒少扶助,擴展原鄉與偏鄉服務。',
    hasLogo: true,
    categoryKeys: ['child_care', 'community_development', 'poverty_relief'],
  },
  {
    name: '荒野保護協會',
    description: '守護台灣自然棲地、推動環境教育與公民參與。',
    nameEn: 'Society of Wilderness',
    descriptionEn: 'Protecting natural habitats and promoting environmental education.',
    hasLogo: true,
    categoryKeys: ['environmental_protection', 'education_advocacy'],
  },
  {
    name: '台灣綠色公民行動聯盟',
    description: '監督能源政策、推動氣候正義。',
    categoryKeys: ['environmental_protection', 'public_issue'],
  },
  {
    name: '財團法人婦女救援基金會',
    description: '陪伴受暴婦女、人口販運倖存者,推動性別平等政策。',
    categoryKeys: ['women_care', 'public_issue'],
  },
  {
    name: '財團法人新事社會服務中心',
    description: '陪伴移工、新住民,推動勞動權益與多元文化共融。',
    categoryKeys: ['diversity', 'community_development'],
  },
  {
    name: '台灣藝術文化推廣協會',
    description: '推動偏鄉藝術教育、巡演經典劇目、培育青年表演者。',
    hasLogo: true,
    categoryKeys: ['arts_culture', 'community_development'],
  },
  {
    name: '台灣公民媒體素養協會',
    description: '推動媒體識讀教育、打擊不實訊息。',
    categoryKeys: ['media', 'education_advocacy', 'public_issue'],
  },
  {
    name: '中華民國體育志工協會',
    description: '推廣偏鄉體育、培育基層運動員。',
    categoryKeys: ['sports_development', 'child_care'],
  },
  {
    name: '台灣國際醫療援助協會',
    description: '派遣志工醫護人員至東南亞與非洲提供醫療服務。',
    nameEn: 'Taiwan International Medical Aid',
    descriptionEn: 'Volunteer medical missions to Southeast Asia and Africa.',
    categoryKeys: ['international_aid', 'special_medical'],
  },
  {
    name: '台灣社區規劃發展協會',
    description: '陪伴社區自主治理、文化保存與青年返鄉。',
    categoryKeys: ['community_development', 'arts_culture'],
  },
  {
    name: '中華民國老人福利推動聯盟',
    description: '推動長照政策、串連在地服務、培訓照顧人員。',
    categoryKeys: ['elderly_care', 'public_issue'],
  },
  // ── Lifecycle demo rows ──────────────────────────────────────────────
  {
    name: '已封存示範團體(archived demo)',
    description: 'archivedAt 在過去 — 不應出現在 public list。',
    archivedAt: past(7),
    categoryKeys: ['poverty_relief'],
  },
  {
    name: '已軟刪示範團體(deleted demo)',
    description: 'deletedAt 在過去 — 所有 endpoint 都不應看到。',
    deletedAt: past(3),
    categoryKeys: ['poverty_relief'],
  },
  {
    name: '合約過期示範團體(cascade demo)',
    description: 'publishEndAt 已過 — 子表 Project/SaleItem 將一併消失。',
    publishEndAt: past(1),
    categoryKeys: ['animal_protection'],
  },
] as const

if (CHARITIES.length < 20) {
  throw new Error(`seed/charities.ts: need ≥ 20 charities, got ${CHARITIES.length.toString()}`)
}

export interface SeededCharity {
  id: string
  name: string
  /** true when this row will pass `whereLive` AT seed-reference-time. */
  liveAtRef: boolean
}

export async function seedCharities(
  prisma: PrismaClient,
  categoryIdByKey: Map<CategoryKey, string>,
  uploadLogo: (key: string) => Promise<void>,
): Promise<SeededCharity[]> {
  const seeded: SeededCharity[] = []

  for (const c of CHARITIES) {
    // First create the charity row to get its uuid (the S3 key embeds it).
    const row = await prisma.charity.create({
      data: {
        name: c.name,
        description: c.description,
        nameEn: c.nameEn,
        descriptionEn: c.descriptionEn,
        contactPhone: c.contactPhone,
        contactEmail: c.contactEmail,
        officialWebsite: c.officialWebsite,
        approvalNo: c.approvalNo,
        displayOrder: c.displayOrder ?? 0,
        archivedAt: c.archivedAt,
        deletedAt: c.deletedAt,
        publishStartAt: c.publishStartAt,
        publishEndAt: c.publishEndAt,
      },
    })

    // Upload placeholder logo to S3 and write the key back (spec 015 §6.4 v0.8).
    if (c.hasLogo) {
      const key = buildKey({ entity: 'charities', id: row.id, purpose: 'logo', ext: 'png' })
      await uploadLogo(key)
      await prisma.charity.update({ where: { id: row.id }, data: { logoKey: key } })
    }

    // Attach categories (M:N join).
    for (const ck of c.categoryKeys) {
      const categoryId = categoryIdByKey.get(ck)
      if (!categoryId) throw new Error(`seed/charities.ts: unknown category key ${ck}`)
      await prisma.charityOnCategory.create({
        data: { charityId: row.id, categoryId },
      })
    }

    seeded.push({
      id: row.id,
      name: c.name,
      liveAtRef:
        c.archivedAt === undefined &&
        c.deletedAt === undefined &&
        (c.publishStartAt === undefined || c.publishStartAt <= REF) &&
        (c.publishEndAt === undefined || c.publishEndAt > REF),
    })
  }

  return seeded
}
