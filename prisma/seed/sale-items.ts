// Spec 015 §6.4 — SaleItem seed.
//
// Volume: ≥ 30 rows. Same round-robin pattern as donation-projects but with
// priceTwd diversity (100 / 920 / 1000 / 1170 / 1330 / 2580 / 4500). Cascade
// demo charity gets extras so its children disappear when the parent's
// publishEndAt is in the past.

import type { PrismaClient } from '@prisma/client'

import { buildKey } from '../../src/lib/s3/index.js'

import type { SeededCharity } from './charities.js'

const REF = new Date('2026-06-14T12:00:00.000Z')
const past = (days: number): Date => new Date(REF.getTime() - days * 86_400_000)
const future = (days: number): Date => new Date(REF.getTime() + days * 86_400_000)

interface ItemTemplate {
  name: string
  description: string
  nameEn?: string
  descriptionEn?: string
  content: string
  contentEn?: string
  priceTwd: number
  hasCover?: boolean
  raisingApprovalNo?: string
  reliefApprovalNo?: string
}

const TEMPLATES: readonly ItemTemplate[] = [
  {
    name: '北歐天然 小型寵物魚油 2oz',
    description: '勸募立案核准字號 衛部救字第1141364521號',
    nameEn: 'Nordic Natural Pet Fish Oil 2oz',
    descriptionEn: 'Premium fish oil for small pets — supports skin and coat health.',
    content:
      '每一筆愛購,我們將提撥約 30% 的金額,捐贈「台灣紅絲帶基金會」,用於支持流浪動物醫療照護。',
    contentEn: 'Each purchase donates ~30% to support stray animal medical care.',
    priceTwd: 1000,
    hasCover: true,
    raisingApprovalNo: '勸募立案核准字號 衛部救字第1141364521號',
    reliefApprovalNo: '衛部救字第1141364521號',
  },
  {
    name: '手工流浪動物造型卡片(10 入)',
    description: '部落媽媽手繪卡片,每張描繪一隻被救援的浪浪。',
    nameEn: 'Handmade Stray-Animal Greeting Cards (10-pack)',
    descriptionEn: 'Each card hand-painted by tribal mothers, featuring a rescued stray.',
    content: '收益全數投入流浪動物 TNR 計畫。',
    priceTwd: 920,
    hasCover: true,
  },
  {
    name: '兒童課輔陪伴包(文具 + 圖書套裝)',
    description: '為弱勢兒童準備的開學文具與閱讀套裝。',
    content: '購買 1 份,我們將直接送出 1 份給弱勢家庭兒童;另有 30% 收益投入課輔人員培訓。',
    priceTwd: 1170,
  },
  {
    name: '原鄉部落手工皂(薰衣草 / 艾草 / 茶樹)',
    description: '由部落婦女合作社製作,純天然冷製皂。',
    content: '收益用於部落婦女自立創業基金。',
    priceTwd: 480,
    hasCover: true,
  },
  {
    name: '陽光義賣 — 復康訓練教具組',
    description: '為燒傷與顏面損傷者復健所設計的細部精修教具。',
    content: '收益全數用於陽光中心的復健課程開支。',
    priceTwd: 2580,
    hasCover: true,
  },
  {
    name: '長者健腦桌遊組',
    description: '專為失智症初期長者設計的桌遊,簡單規則、可重複玩。',
    nameEn: 'Brain-Training Tabletop Game for Elders',
    descriptionEn: 'Designed for early-stage dementia — simple, repeatable rules.',
    content: '收益投入失智症關懷講師培訓計畫。',
    priceTwd: 1330,
  },
  {
    name: '婦女自立 — 蜂蜜茶禮盒',
    description: '北部山區受暴婦女合作社出品,純國產蜂蜜與紅茶。',
    content: '購買即直接支持 12 位脫離家暴關係的婦女自立創業。',
    priceTwd: 850,
    hasCover: true,
  },
  {
    name: '海岸線淨灘紀念 T-shirt',
    description: '海洋藍 / 鵝黃兩色,有機棉,袖口繡有去年淨灘公里數。',
    nameEn: 'Coastal Cleanup Commemorative T-shirt',
    descriptionEn: 'Organic cotton tee in ocean blue or canary yellow; sleeve embroidery records last-year cleanup mileage.',
    content: '每件 80% 收益投入淨灘計畫常備經費。',
    contentEn: '80% of each sale supports ongoing beach cleanup efforts.',
    priceTwd: 720,
    hasCover: true,
  },
  {
    name: '兒童基層棒球 — 簽名球(限量)',
    description: '由現役職業球員親簽 100 顆比賽用球。',
    content: '單顆收益全數投入偏鄉棒球新苗培育計畫。',
    priceTwd: 4500,
    hasCover: true,
  },
  {
    name: '部落 podcast 月度贊助包',
    description: '單月內 podcast 結尾感謝牌 + 限定電子明信片。',
    content: '月度小額贊助制,適合公司行號企業社會責任配置。',
    priceTwd: 300,
  },
  {
    name: '國際救援應急口糧(模擬包)',
    description: '我們在災區實際使用的口糧版本,可作為居家防災備品。',
    content: '收益投入應急救援物資常備基金。',
    priceTwd: 580,
    hasCover: true,
  },
  {
    name: '社區青年小農果醬禮盒',
    description: '由返鄉青農合作社製作的當季果醬 4 入禮盒。',
    content: '收益直接投入青年返鄉孵化計畫。',
    priceTwd: 990,
    hasCover: true,
  },
  // ── +4 templates (2026-06-14):16 templates × 3 cycles + 3 cascade extras = 51 rows.
  {
    name: '身障烘焙坊 — 手作餅乾禮盒',
    description: '由身障者組成的烘焙坊製作,純手工餅乾。',
    nameEn: 'Disability Bakery — Handmade Cookie Gift Box',
    descriptionEn: 'Handmade cookies produced by a bakery staffed by people with disabilities.',
    content: '每盒收益的 80% 投入身障者就業培訓。',
    contentEn: '80% of each sale supports disability employment training.',
    priceTwd: 680,
    hasCover: true,
  },
  {
    name: '多元家庭驕傲遊行紀念布章',
    description: '每年一款設計的限定布章,可縫於背包或外套。',
    content: '收益投入多元家庭法律支援基金。',
    priceTwd: 250,
    hasCover: true,
  },
  {
    name: '海洋保育珊瑚陶杯(藍 / 綠)',
    description: '陶藝家手作,圖案為復育珊瑚。',
    nameEn: 'Ocean Conservation Coral Ceramic Mug (Blue / Green)',
    descriptionEn: 'Hand-crafted by ceramic artist; design features restored coral.',
    content: '單杯收益的 60% 投入珊瑚復育計畫。',
    contentEn: '60% of each sale supports coral restoration.',
    priceTwd: 880,
    hasCover: true,
  },
  {
    name: '罕病兒童手繪明信片(10 入)',
    description: '由罕病病童繪製的明信片組,每張背面有小故事。',
    content: '購買即支持罕病家庭喘息照顧基金。',
    priceTwd: 350,
  },
] as const

interface ScheduleOverride {
  publishStartAt?: Date
  publishEndAt?: Date
}

// Three-state publish demos for SaleItem: 限時開賣 / 預售 / 已下架.
const SCHEDULE_BY_INDEX: Record<number, ScheduleOverride> = {
  1: { publishStartAt: past(15), publishEndAt: future(30) }, // 上架中(有界)
  2: { publishStartAt: future(7) },                          // 預售
  3: { publishEndAt: past(3) },                              // 已下架
}

export async function seedSaleItems(
  prisma: PrismaClient,
  charities: SeededCharity[],
  uploadAsset: (key: string) => Promise<void>,
): Promise<void> {
  const cascadeDemoCharity = charities.find((c) => c.name.includes('合約過期'))
  if (!cascadeDemoCharity) {
    throw new Error('seed/sale-items.ts: cascade demo charity not found in seeded charities')
  }
  const liveCharities = charities.filter((c) => c.liveAtRef && c !== cascadeDemoCharity)
  if (liveCharities.length === 0) {
    throw new Error('seed/sale-items.ts: no live charity to attach sale items to')
  }

  let idx = 0
  for (let cycle = 0; cycle < 3; cycle += 1) {
    for (const tpl of TEMPLATES) {
      const charity = liveCharities[idx % liveCharities.length]!
      const schedule = SCHEDULE_BY_INDEX[idx] ?? {}
      await createSaleItem(prisma, charity.id, tpl, schedule, cycle, uploadAsset)
      idx += 1
    }
    // Extra under cascade demo charity.
    await createSaleItem(
      prisma,
      cascadeDemoCharity.id,
      TEMPLATES[cycle % TEMPLATES.length]!,
      {},
      cycle + 100,
      uploadAsset,
    )
  }
}

async function createSaleItem(
  prisma: PrismaClient,
  charityId: string,
  tpl: ItemTemplate,
  schedule: ScheduleOverride,
  uniqueIdx: number,
  uploadAsset: (key: string) => Promise<void>,
): Promise<void> {
  const row = await prisma.saleItem.create({
    data: {
      charityId,
      name: `${tpl.name}${uniqueIdx === 0 ? '' : ` #${uniqueIdx.toString()}`}`,
      description: tpl.description,
      nameEn: tpl.nameEn,
      descriptionEn: tpl.descriptionEn,
      content: tpl.content,
      contentEn: tpl.contentEn,
      priceTwd: tpl.priceTwd,
      raisingApprovalNo: tpl.raisingApprovalNo,
      reliefApprovalNo: tpl.reliefApprovalNo,
      publishStartAt: schedule.publishStartAt,
      publishEndAt: schedule.publishEndAt,
    },
  })

  if (tpl.hasCover) {
    const coverKey = buildKey({
      entity: 'sale-items',
      id: row.id,
      purpose: 'cover',
      ext: 'jpg',
    })
    await uploadAsset(coverKey)
    await prisma.saleItem.update({
      where: { id: row.id },
      data: { coverImageKey: coverKey },
    })
  }
}
