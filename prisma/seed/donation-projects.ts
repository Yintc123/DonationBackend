// Spec 015 §6.4 — DonationProject seed.
//
// Volume: spec demands ≥ 30 rows. We generate 36 (3 × 12 base templates),
// distributing them round-robin across the live-at-ref charities so each
// charity gets ≥ 1 project. We deliberately keep 3 extras (one per template
// cycle) attached to the cascade-demo charity (publishEndAt past) so the
// cascading visibility demo has multiple children to disappear with it.

import type { PrismaClient } from '@prisma/client'

import { buildKey } from '../../src/lib/s3/index.js'

import type { SeededCharity } from './charities.js'

const REF = new Date('2026-06-14T12:00:00.000Z')
const past = (days: number): Date => new Date(REF.getTime() - days * 86_400_000)
const future = (days: number): Date => new Date(REF.getTime() + days * 86_400_000)

interface ProjectTemplate {
  name: string
  description: string
  nameEn?: string
  descriptionEn?: string
  content: string
  contentEn?: string
  hasCover?: boolean
  raisingApprovalNo?: string
  reliefApprovalNo?: string
}

const TEMPLATES: readonly ProjectTemplate[] = [
  {
    name: '【安居・專業・愛】守護身障弱勢,共築安全專業家園勸募活動',
    description: '勸募立案核准字號 衛部救字第1151361613號',
    content:
      '圓夢守護 60 位心智障礙者的避風港,柏拉圖復康之家需要您的支持!【關於我們:他們一輩子的家】柏拉圖復康之家位於宜蘭縣,提供 60 位身心障礙者長期住宿與職能訓練。我們需要您的支持,讓他們有一個安全、有尊嚴的家。',
    contentEn:
      'Help us protect a lifelong home for 60 individuals with intellectual disabilities at Plato Rehabilitation Center.',
    hasCover: true,
    raisingApprovalNo: '勸募立案核准字號 衛部救字第1151361613號',
    reliefApprovalNo: '衛部救字第1151361613號',
  },
  {
    name: '陪伴流浪動物 — 從街頭到家',
    description: '醫療、結紮、認養媒合一站式服務。',
    nameEn: 'From Street to Home — Stray Animal Companion Program',
    descriptionEn: 'Medical care, sterilisation, and adoption matching for stray animals.',
    content: '每一隻流浪動物背後都有一段故事。我們提供醫療救援、結紮絕育、行為訓練,以及與家庭的耐心媒合。',
    contentEn: 'Every stray animal has a story. We provide rescue, sterilisation, training, and matching with families.',
    hasCover: true,
  },
  {
    name: '弱勢家庭兒童課後陪伴計畫',
    description: '經濟弱勢學童的課業輔導與心理陪伴。',
    content: '提供 200 位弱勢家庭學童每週課後陪伴 5 小時,內容包含課業輔導、體育活動與情緒對話。',
  },
  {
    name: '偏鄉長者送餐計畫',
    description: '為山區獨居長者提供每日熱食。',
    content: '我們的志工每天行駛 80 公里山路,為 50 位獨居長者送餐並關心健康狀況。',
  },
  {
    name: '心智障礙者職場體驗計畫',
    description: '與企業合作建構支持性就業環境。',
    nameEn: 'Workplace Experience Program for People with Intellectual Disabilities',
    descriptionEn: 'Partnering with companies to build supported-employment environments.',
    content: '透過為期 12 週的職場體驗,協助心智障礙者找到適合的工作環境。',
    hasCover: true,
  },
  {
    name: '婦女自立創業微型貸款計畫',
    description: '陪伴離開家暴關係的婦女重新建立經濟生活。',
    content: '提供無息微型創業貸款 + 一對一陪伴顧問,協助受暴婦女回到職場。',
  },
  {
    name: '原鄉文化保存記錄計畫',
    description: '記錄部落耆老口述歷史與傳統技藝。',
    content: '由部落青年返鄉執行為期 2 年的文化記錄,出版有聲書與紀錄片。',
    hasCover: true,
  },
  {
    name: '媒體素養教師培訓計畫',
    description: '培訓 300 位中學教師具備教媒體識讀能力。',
    content: '為期 3 個月的密集培訓 + 教案開發,讓教師有能力把媒體識讀帶入課堂。',
    raisingApprovalNo: '勸募立案核准字號 衛部救字第1141220103號',
  },
  {
    name: '海岸線淨灘與棲地復育計畫',
    description: '組織志工每月淨灘,並追蹤海漂垃圾來源。',
    nameEn: 'Coastal Cleanup and Habitat Restoration',
    descriptionEn: 'Monthly volunteer beach cleanups with marine debris source tracking.',
    content: '每月於東北角海岸組織 100 位志工進行淨灘,並進行漁網、塑膠瓶來源分析。',
    contentEn: 'Monthly beach cleanups along the Northeast Coast with debris source analysis.',
    hasCover: true,
  },
  {
    name: '基層棒球新苗培育計畫',
    description: '為偏鄉學校提供器材、教練與比賽機會。',
    content: '與 12 所偏鄉小學合作,提供球具、聘請教練,並安排月度交流賽。',
  },
  {
    name: '國際緊急救援基金',
    description: '當天災發生時的第一線物資與醫療援助。',
    content: '建立 500 萬元常備基金,當亞洲鄰國發生天災時可在 48 小時內到位。',
    hasCover: true,
  },
  {
    name: '社區青年創業孵化計畫',
    description: '陪伴返鄉青年從 idea 走到 minimum viable business。',
    content: '為期 6 個月的孵化期,提供導師、空間、與第一筆 5 萬元種子資金。',
  },
  // ── +4 templates (2026-06-14):16 templates × 3 cycles + 3 cascade extras = 51 rows.
  {
    name: '身障音樂治療教室建置計畫',
    description: '為發展遲緩兒童建立 5 間音樂治療教室。',
    nameEn: 'Music Therapy Classroom Build Program',
    descriptionEn: 'Building 5 music therapy classrooms for developmentally delayed children.',
    content: '與專業音樂治療師合作設計教室空間,採購樂器、隔音材料,並訓練 20 名社工。',
    contentEn: 'Co-designed with music therapists; equipment, soundproofing, training for 20 social workers.',
    hasCover: true,
  },
  {
    name: '多元家庭法律諮詢專案',
    description: '為 LGBTQ+ 家庭提供免費法律諮詢與訴訟支援。',
    content: '與律師事務所合作建立 pro bono 法律支援網,涵蓋婚姻、收養、繼承等議題。',
  },
  {
    name: '海岸珊瑚礁復育試點計畫',
    description: '在墾丁與綠島建立珊瑚復育示範區。',
    nameEn: 'Coral Reef Restoration Pilot',
    descriptionEn: 'Coral restoration demonstration zones in Kenting and Green Island.',
    content: '與海洋生物學家合作,在 5 公頃海域進行珊瑚移植與監測。',
    contentEn: 'Partnering with marine biologists to transplant and monitor corals across a 5-hectare zone.',
    hasCover: true,
  },
  {
    name: '罕病家庭喘息照顧服務',
    description: '為罕病病童家長提供每月 24 小時的喘息照顧。',
    content: '訓練合格照顧員到府接手照顧,讓主要照顧者可以休息、處理個人事務。',
    raisingApprovalNo: '勸募立案核准字號 衛部救字第1151450000號',
  },
] as const

interface ScheduleOverride {
  publishStartAt?: Date
  publishEndAt?: Date
}

// Three-state publish schedule demos: one future, one past, one explicit
// "live now" with both bounds set. Distributed in the first 6 generated rows.
const SCHEDULE_BY_INDEX: Record<number, ScheduleOverride> = {
  // index 0: 預設「永久上架」(無 publishStart/End)
  1: { publishStartAt: past(30), publishEndAt: future(60) }, // 募款進行中
  2: { publishStartAt: future(14) },                          // 預售中 / 募款未開始
  3: { publishEndAt: past(5) },                               // 募款已結束
}

export async function seedDonationProjects(
  prisma: PrismaClient,
  charities: SeededCharity[],
  uploadAsset: (key: string) => Promise<void>,
): Promise<void> {
  // Find charities by tag — we want to attach 3 extras to the cascade demo.
  const cascadeDemoCharity = charities.find((c) => c.name.includes('合約過期'))
  if (!cascadeDemoCharity) {
    throw new Error('seed/donation-projects.ts: cascade demo charity not found in seeded charities')
  }
  const liveCharities = charities.filter((c) => c.liveAtRef && c !== cascadeDemoCharity)
  if (liveCharities.length === 0) {
    throw new Error('seed/donation-projects.ts: no live charity to attach projects to')
  }

  // 3 cycles × 12 templates = 36 rows total. Round-robin onto live charities
  // (ensures each charity gets ≥ 1 project), then attach 3 extras to the
  // cascade demo charity (one per cycle, so visibility cascade demo has
  // children at both the live and the under-an-expired-parent state).
  let idx = 0
  for (let cycle = 0; cycle < 3; cycle += 1) {
    for (const tpl of TEMPLATES) {
      const charity = liveCharities[idx % liveCharities.length]!
      const schedule = SCHEDULE_BY_INDEX[idx] ?? {}
      await createProject(prisma, charity.id, tpl, schedule, cycle, uploadAsset)
      idx += 1
    }
    // One extra under the cascade-demo charity per cycle.
    await createProject(
      prisma,
      cascadeDemoCharity.id,
      TEMPLATES[cycle % TEMPLATES.length]!,
      {},
      cycle + 100,
      uploadAsset,
    )
  }
}

async function createProject(
  prisma: PrismaClient,
  charityId: string,
  tpl: ProjectTemplate,
  schedule: ScheduleOverride,
  uniqueIdx: number,
  uploadAsset: (key: string) => Promise<void>,
): Promise<void> {
  const row = await prisma.donationProject.create({
    data: {
      charityId,
      name: `${tpl.name}${uniqueIdx === 0 ? '' : ` #${uniqueIdx.toString()}`}`,
      description: tpl.description,
      nameEn: tpl.nameEn,
      descriptionEn: tpl.descriptionEn,
      content: tpl.content,
      contentEn: tpl.contentEn,
      raisingApprovalNo: tpl.raisingApprovalNo,
      reliefApprovalNo: tpl.reliefApprovalNo,
      publishStartAt: schedule.publishStartAt,
      publishEndAt: schedule.publishEndAt,
    },
  })

  if (tpl.hasCover) {
    const coverKey = buildKey({
      entity: 'donation-projects',
      id: row.id,
      purpose: 'cover',
      ext: 'jpg',
    })
    await uploadAsset(coverKey)
    await prisma.donationProject.update({
      where: { id: row.id },
      data: { coverImageKey: coverKey },
    })
  }
}
