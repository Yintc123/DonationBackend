// Spec 015 §6.4 — Charity seed.
//
// Two kinds of rows, kept in separate typed arrays so TypeScript enforces
// the intent:
//
//   COMPLETE_CHARITIES — 20 rows. EVERY UI / i18n / compliance field is
//     REQUIRED (the type has no optional non-lifecycle fields). The seed.ts
//     post-condition asserts ≥ 20 such complete rows landed in the DB.
//
//   LIFECYCLE_DEMO_CHARITIES — 3 rows. Intentionally sparse — exists to
//     exercise the archived / deleted / cascade-expired branches of the
//     `whereLive` helper. Filling these would defeat the demos' purpose.
//
// "Complete" bar (locked with user 2026-06-14):
//   logo, name, description       — surfaced on the Figma list card
//   nameEn, descriptionEn         — i18n parity (ADR 004 Pattern A)
//   contactPhone, contactEmail,
//   officialWebsite, approvalNo   — compliance / IMG_4876 disclosure
//
// Contact / approval values for non-ACC rows come from `fakeContact(slug, idx)`
// — deterministic placeholders shaped like the real thing but obviously fake
// (`.example.org`, padded indexes) so a reviewer can never mistake them for
// a live charity's data.

import type { PrismaClient } from '@prisma/client'

import { buildKey } from '../../src/lib/s3/index.js'

import type { CategoryKey } from '../../src/domain/category/keys.js'

// ─── Fake-contact generator ───────────────────────────────────────────────
// Stable per (slug, idx) so re-running the seed always produces the same
// strings. Idx is 1-based — keeps the padding readable in DB dumps.

interface FakeContact {
  contactPhone: string
  contactEmail: string
  officialWebsite: string
  approvalNo: string
}

function fakeContact(slug: string, idx: number): FakeContact {
  const padded3 = idx.toString().padStart(3, '0')
  const padded4 = idx.toString().padStart(4, '0')
  return {
    // Format: Taipei landline shape (02-2XXX-XXXX). Reserved 0000 suffix
    // pattern keeps it unmistakably non-routable.
    contactPhone: `02-2${padded3}-${padded4}`,
    contactEmail: `info@${slug}.example.org`,
    officialWebsite: `https://www.${slug}.example.org`,
    // Format mimics 內政部團字第NNNNNNNNNN號 — 10 digits, all zeros padded
    // around the index so no chance of colliding with a real registration.
    approvalNo: `台內團字第111${padded3}0000號`,
  }
}

// ─── Types ────────────────────────────────────────────────────────────────

// Complete row: every "must-have" field is required (no `?`). TypeScript
// fails the build if a row in COMPLETE_CHARITIES is missing one — that's the
// whole point of a separate type.
interface CompleteCharitySeed {
  slug: string
  name: string
  description: string
  nameEn: string
  descriptionEn: string
  // Contact fields can either be inline (for ACC's legacy real-ish row, kept
  // as the "this is what real data shape looks like" baseline) or computed
  // from fakeContact() at iteration time. We keep them OPTIONAL here and
  // backfill at iteration time when absent.
  contactPhone?: string
  contactEmail?: string
  officialWebsite?: string
  approvalNo?: string
  displayOrder?: number
  publishStartAt?: Date
  publishEndAt?: Date
  categoryKeys: CategoryKey[]
}

// Lifecycle demo row: most fields can be empty — the point of the row is to
// exercise the archived/deleted/cascade-expired branches.
interface LifecycleDemoCharitySeed {
  name: string
  description: string
  archivedAt?: Date
  deletedAt?: Date
  publishStartAt?: Date
  publishEndAt?: Date
  categoryKeys: CategoryKey[]
}

const REF = new Date('2026-06-14T12:00:00.000Z')
const past = (days: number): Date => new Date(REF.getTime() - days * 86_400_000)

// ─── Complete rows (20) ───────────────────────────────────────────────────

const COMPLETE_CHARITIES: readonly CompleteCharitySeed[] = [
  // Pinned / featured — displayOrder negative so they sort first.
  {
    slug: 'acc-elder-youth-care',
    name: 'ACC 中華耆幼關懷協會',
    description: '當你長大時,你會發現你有兩隻手,一隻用來幫助自己,一隻來幫助別人。我們陪伴老人,也陪伴孩子。',
    nameEn: 'ACC Chinese Elder & Youth Care Association',
    descriptionEn: 'Walking with the elderly and the young — a hand for yourself, a hand for others.',
    displayOrder: -2,
    categoryKeys: ['child_care', 'elderly_care', 'poverty_relief'],
  },
  {
    slug: 'taiwan-stray-animal',
    name: '台灣流浪動物之家基金會',
    description: '收容無家可歸的犬貓,推動以領養代替購買、結紮代替撲殺。',
    nameEn: 'Taiwan Stray Animal Sanctuary Foundation',
    descriptionEn: 'Sheltering stray dogs and cats; adopt, do not shop.',
    displayOrder: -1,
    categoryKeys: ['animal_protection'],
  },
  // 一般列。
  {
    slug: 'animal-welfare-promotion',
    name: '中華民國動物福利促進協會',
    description: '推動流浪動物 TNR(誘捕、結紮、回置)與動物福利立法。',
    nameEn: 'Animal Welfare Promotion Association',
    descriptionEn: 'Promoting TNR for stray animals and welfare legislation.',
    categoryKeys: ['animal_protection', 'public_issue'],
  },
  {
    slug: 'world-vision-taiwan',
    name: '台灣世界展望會',
    description: '長期關懷貧困兒童、推動社區發展、緊急人道救援。',
    nameEn: 'World Vision Taiwan',
    descriptionEn: 'Long-term care for children in poverty, community development, and emergency humanitarian relief.',
    categoryKeys: ['child_care', 'international_aid', 'poverty_relief'],
  },
  {
    slug: 'tfcf-taiwan',
    name: '台灣兒童暨家庭扶助基金會',
    description: '陪伴經濟弱勢家庭與兒少,提供家庭支持、教育補助與心理輔導。',
    nameEn: 'Taiwan Fund for Children and Families',
    descriptionEn: 'Supporting families in economic hardship with mentorship and education.',
    categoryKeys: ['child_care', 'poverty_relief'],
  },
  {
    slug: 'eden-social-welfare',
    name: '伊甸社會福利基金會',
    description: '服務身心障礙者家庭、推動無障礙環境與職業重建。',
    nameEn: 'Eden Social Welfare Foundation',
    descriptionEn: 'Serving families of people with disabilities; advancing accessibility and vocational rehabilitation.',
    categoryKeys: ['disability_service', 'community_development'],
  },
  {
    slug: 'genesis-social-welfare',
    name: '創世社會福利基金會',
    description: '照顧植物人與貧苦長者,推動社區安寧。',
    nameEn: 'Genesis Social Welfare Foundation',
    descriptionEn: 'Caring for individuals in vegetative state and elders in poverty; community hospice services.',
    categoryKeys: ['elderly_care', 'special_medical'],
  },
  {
    slug: 'sunshine-social-welfare',
    name: '陽光社會福利基金會',
    description: '陪伴顏面損傷與燒傷者重返社會。',
    nameEn: 'Sunshine Social Welfare Foundation',
    descriptionEn: 'Supporting survivors of facial disfigurement and burns to reintegrate into society.',
    categoryKeys: ['special_medical', 'disability_service'],
  },
  {
    slug: 'garden-of-hope',
    name: '台灣勵馨基金會',
    description: '陪伴遭受性別暴力的婦女與青少女,倡議性別正義。',
    nameEn: 'Garden of Hope Foundation',
    descriptionEn: 'Supporting women and adolescent girls affected by gender-based violence; advocating gender justice.',
    categoryKeys: ['women_care', 'public_issue'],
  },
  {
    slug: 'tfcf-family-mentorship',
    name: '台灣家扶基金會',
    description: '深耕弱勢家庭與兒少扶助,擴展原鄉與偏鄉服務。',
    nameEn: 'TFCF Family Mentorship Program',
    descriptionEn: 'Deep-rooted support for disadvantaged families and children; expanding services to indigenous and rural areas.',
    categoryKeys: ['child_care', 'community_development', 'poverty_relief'],
  },
  {
    slug: 'society-of-wilderness',
    name: '荒野保護協會',
    description: '守護台灣自然棲地、推動環境教育與公民參與。',
    nameEn: 'Society of Wilderness',
    descriptionEn: 'Protecting natural habitats and promoting environmental education.',
    categoryKeys: ['environmental_protection', 'education_advocacy'],
  },
  {
    slug: 'green-citizens-action',
    name: '台灣綠色公民行動聯盟',
    description: '監督能源政策、推動氣候正義。',
    nameEn: 'Green Citizens Action Alliance',
    descriptionEn: 'Monitoring energy policy and advancing climate justice.',
    categoryKeys: ['environmental_protection', 'public_issue'],
  },
  {
    slug: 'taipei-women-rescue',
    name: '財團法人婦女救援基金會',
    description: '陪伴受暴婦女、人口販運倖存者,推動性別平等政策。',
    nameEn: 'Taipei Women Rescue Foundation',
    descriptionEn: 'Supporting survivors of domestic violence and human trafficking; advancing gender equality policy.',
    categoryKeys: ['women_care', 'public_issue'],
  },
  {
    slug: 'rerum-novarum-center',
    name: '財團法人新事社會服務中心',
    description: '陪伴移工、新住民,推動勞動權益與多元文化共融。',
    nameEn: 'Rerum Novarum Social Service Center',
    descriptionEn: 'Supporting migrant workers and new immigrants; advancing labor rights and multicultural inclusion.',
    categoryKeys: ['diversity', 'community_development'],
  },
  {
    slug: 'taiwan-arts-culture',
    name: '台灣藝術文化推廣協會',
    description: '推動偏鄉藝術教育、巡演經典劇目、培育青年表演者。',
    nameEn: 'Taiwan Arts & Culture Promotion Association',
    descriptionEn: 'Promoting arts education in rural areas; touring classical productions; training young performers.',
    categoryKeys: ['arts_culture', 'community_development'],
  },
  {
    slug: 'citizen-media-literacy',
    name: '台灣公民媒體素養協會',
    description: '推動媒體識讀教育、打擊不實訊息。',
    nameEn: 'Citizen Media Literacy Association',
    descriptionEn: 'Advancing media literacy education and combating disinformation.',
    categoryKeys: ['media', 'education_advocacy', 'public_issue'],
  },
  {
    slug: 'sports-volunteer-association',
    name: '中華民國體育志工協會',
    description: '推廣偏鄉體育、培育基層運動員。',
    nameEn: 'Sports Volunteer Association',
    descriptionEn: 'Promoting sports in rural areas and developing grassroots athletes.',
    categoryKeys: ['sports_development', 'child_care'],
  },
  {
    slug: 'taiwan-medical-aid',
    name: '台灣國際醫療援助協會',
    description: '派遣志工醫護人員至東南亞與非洲提供醫療服務。',
    nameEn: 'Taiwan International Medical Aid',
    descriptionEn: 'Volunteer medical missions to Southeast Asia and Africa.',
    categoryKeys: ['international_aid', 'special_medical'],
  },
  {
    slug: 'community-planning-association',
    name: '台灣社區規劃發展協會',
    description: '陪伴社區自主治理、文化保存與青年返鄉。',
    nameEn: 'Community Planning Development Association',
    descriptionEn: 'Supporting community self-governance, cultural preservation, and youth returning home.',
    categoryKeys: ['community_development', 'arts_culture'],
  },
  {
    slug: 'senior-welfare-alliance',
    name: '中華民國老人福利推動聯盟',
    description: '推動長照政策、串連在地服務、培訓照顧人員。',
    nameEn: 'Senior Welfare Promotion Alliance',
    descriptionEn: 'Advancing long-term care policy, connecting local services, and training caregivers.',
    categoryKeys: ['elderly_care', 'public_issue'],
  },
  // ── +10 rows (2026-06-14):補齊較少出現的分類(diversity / media /
  //    sports / 罕病 / 失智 / 海洋)。所有 9 欄位透過型別 + 生成器自動填齊。
  {
    slug: 'children-music-therapy',
    name: '中華兒童音樂治療協會',
    description: '透過音樂治療陪伴自閉症兒童與發展遲緩兒童的成長。',
    nameEn: 'Children Music Therapy Association of ROC',
    descriptionEn: 'Supporting autistic and developmentally delayed children through music therapy.',
    categoryKeys: ['child_care', 'disability_service'],
  },
  {
    slug: 'taiwan-pride-care',
    name: '台灣多元成家照顧協會',
    description: '陪伴 LGBTQ+ 族群與多元家庭面對社會適應與權益爭取。',
    nameEn: 'Taiwan Pride Family Care Association',
    descriptionEn: 'Supporting LGBTQ+ communities and diverse families with social adaptation and rights advocacy.',
    categoryKeys: ['diversity', 'public_issue'],
  },
  {
    slug: 'independent-journalism-fund',
    name: '台灣獨立媒體基金會',
    description: '支持小型獨立媒體進行深度調查報導,守護新聞自由。',
    nameEn: 'Taiwan Independent Journalism Foundation',
    descriptionEn: 'Supporting small independent outlets to produce in-depth investigative journalism; defending press freedom.',
    categoryKeys: ['media', 'public_issue'],
  },
  {
    slug: 'taiwan-assistance-dogs',
    name: '台灣身障輔助犬協會',
    description: '訓練導盲犬、肢體輔助犬與聽力輔助犬,免費提供給身障者。',
    nameEn: 'Taiwan Assistance Dogs Association',
    descriptionEn: 'Training guide dogs, mobility-assistance dogs, and hearing dogs for people with disabilities, free of charge.',
    categoryKeys: ['disability_service', 'animal_protection'],
  },
  {
    slug: 'global-children-education-aid',
    name: '台灣國際兒童教育援助協會',
    description: '在東南亞與非洲建立兒童學校與教師培訓計畫。',
    nameEn: 'Taiwan Global Children Education Aid',
    descriptionEn: "Building children's schools and teacher training programs in Southeast Asia and Africa.",
    categoryKeys: ['international_aid', 'child_care', 'education_advocacy'],
  },
  {
    slug: 'ocean-conservation-coalition',
    name: '台灣海洋保育聯盟',
    description: '監測沿海水質、復育珊瑚礁、推動禁塑政策。',
    nameEn: 'Taiwan Ocean Conservation Coalition',
    descriptionEn: 'Monitoring coastal water quality, restoring coral reefs, and advocating plastic-reduction policy.',
    categoryKeys: ['environmental_protection', 'public_issue'],
  },
  {
    slug: 'rare-disease-care',
    name: '中華罕見疾病照顧協會',
    description: '為罕見疾病病童家庭提供醫療諮詢、心理支持與遊戲治療。',
    nameEn: 'Chinese Rare Disease Care Association',
    descriptionEn: 'Providing medical consultation, psychological support, and play therapy for families of children with rare diseases.',
    categoryKeys: ['special_medical', 'child_care'],
  },
  {
    slug: 'dementia-community-support',
    name: '台灣失智症社區共照協會',
    description: '訓練社區友善店家,讓失智長者能安心走出家門。',
    nameEn: 'Taiwan Dementia Community Support Association',
    descriptionEn: 'Training dementia-friendly storefronts so elders with dementia can safely venture out.',
    categoryKeys: ['elderly_care', 'community_development'],
  },
  {
    slug: 'women-economic-empowerment',
    name: '台灣婦女經濟自立基金會',
    description: '提供職訓、創業諮詢與微型貸款,讓婦女不受經濟弱勢限制。',
    nameEn: 'Taiwan Women Economic Empowerment Foundation',
    descriptionEn: 'Providing vocational training, business consulting, and microloans to lift women from economic vulnerability.',
    categoryKeys: ['women_care', 'poverty_relief'],
  },
  {
    slug: 'rural-education-bridge',
    name: '台灣偏鄉教育橋樑協會',
    description: '在台灣 30 個偏遠村落經營課後陪伴中心。',
    nameEn: 'Taiwan Rural Education Bridge Association',
    descriptionEn: 'Operating after-school mentorship centers in 30 remote villages across Taiwan.',
    categoryKeys: ['education_advocacy', 'child_care', 'poverty_relief'],
  },
] as const

if (COMPLETE_CHARITIES.length < 30) {
  throw new Error(
    `seed/charities.ts: COMPLETE_CHARITIES needs ≥ 30 rows, got ${COMPLETE_CHARITIES.length.toString()}`,
  )
}

// ─── Lifecycle demo rows (3) ──────────────────────────────────────────────

const LIFECYCLE_DEMO_CHARITIES: readonly LifecycleDemoCharitySeed[] = [
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
]

// ─── Seeder ───────────────────────────────────────────────────────────────

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

  // Complete rows: always upload a logo and always have all 9 fields filled.
  for (let i = 0; i < COMPLETE_CHARITIES.length; i += 1) {
    const c = COMPLETE_CHARITIES[i]!
    const fake = fakeContact(c.slug, i + 1)
    const row = await prisma.charity.create({
      data: {
        name: c.name,
        description: c.description,
        nameEn: c.nameEn,
        descriptionEn: c.descriptionEn,
        contactPhone: c.contactPhone ?? fake.contactPhone,
        contactEmail: c.contactEmail ?? fake.contactEmail,
        officialWebsite: c.officialWebsite ?? fake.officialWebsite,
        approvalNo: c.approvalNo ?? fake.approvalNo,
        displayOrder: c.displayOrder ?? 0,
        publishStartAt: c.publishStartAt,
        publishEndAt: c.publishEndAt,
      },
    })

    const key = buildKey({ entity: 'charities', id: row.id, purpose: 'logo', ext: 'png' })
    await uploadLogo(key)
    await prisma.charity.update({ where: { id: row.id }, data: { logoKey: key } })

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
        (c.publishStartAt === undefined || c.publishStartAt <= REF) &&
        (c.publishEndAt === undefined || c.publishEndAt > REF),
    })
  }

  // Lifecycle demo rows: sparse on purpose. No logo, no contact info.
  for (const c of LIFECYCLE_DEMO_CHARITIES) {
    const row = await prisma.charity.create({
      data: {
        name: c.name,
        description: c.description,
        archivedAt: c.archivedAt,
        deletedAt: c.deletedAt,
        publishStartAt: c.publishStartAt,
        publishEndAt: c.publishEndAt,
      },
    })

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
