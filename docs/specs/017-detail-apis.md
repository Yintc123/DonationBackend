# Spec 017:詳情頁 API(Charity / DonationProject / SaleItem detail)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.6 |
| 日期 | 2026-06-14 |
| 適用範圍 | `backend/src/routes/v1/donation/charities/get-by-id.ts`、`backend/src/routes/v1/donation/donation-projects/get-by-id.ts`、`backend/src/routes/v1/donation/sale-items/get-by-id.ts`、`backend/src/schemas/donation-item/detail.ts` |
| 相關 ADR | 同 spec 016(專案級 002 Fastify schema-driven、007 Prisma;backend 002 charity-category-model、**backend 004 i18n-storage-model**)+ **backend 006 lifecycle-fields-and-cascading-visibility**(v0.5 — detail endpoint 必須通過 `whereLive` 才回 200,否則 404 不洩漏 archived / deleted)|
| 相關 spec | `015-charity-data-model.md` v0.9(資料來源,lifecycle 欄位來源)、`016-charity-list-api.md` v0.11(list endpoint + 共用 contract 規約 + cascading visibility 規約)、`009-api-response-and-http-status.md`(status / header)、`005-error-handling.md`(錯誤回應)|
| 設計來源 | Figma 截圖補件 IMG_4876(公益團體介紹)/ IMG_4883(捐款專案介紹)/ IMG_4882(義賣商品介紹),2026-06-14 |

---

## 1. 目的與範圍

對應前端 [spec 004 系列詳情頁](../../../frontend/docs/specs/004-detail-pages.md):呈現單一 resource 的完整資料(超過 list 卡片需要的欄位)。

### 1.1 In scope

- `GET /v1/donation/charities/:id`(extended response,加聯絡資訊 / 核准字號 / categories inflated)
- `GET /v1/donation/donation-projects/:id`(extended,加 cover / content / 字號 / nested charity / categories)
- `GET /v1/donation/sale-items/:id`(extended,加 cover / content / priceTwd / 字號 / nested charity / categories)
- TypeBox response schema、Prisma 查詢策略、cache 規約

### 1.2 Out of scope

- list endpoint(spec 016)
- 寫入 endpoint(本作業無後台 UI)
- detail 內 nested 的 `recentProjects[]` / `recentItems[]` 等 cross-link 資料(開放問題 §6.1)— v0.1 由前端各自打 list endpoint 取得(`?charityId=` filter)

---

## 2. 共通規則

| 規約 | 來源 / 規格 |
|---|---|
| URL pattern | `/v1/donation/<resource>/:id`,`id` 為 uuid v4 |
| Auth | public(同 spec 016 §3)|
| `:id` 非 uuid → 400 | `VALIDATION_FAILED`(v0.6 — 對齊 spec 005 §4.2 / spec 016 v0.12 字典;原版本拼成 `_ERROR` 是 drift)|
| 找不到 → 404 | `CHARITY_NOT_FOUND` / `DONATION_PROJECT_NOT_FOUND` / `SALE_ITEM_NOT_FOUND` |
| **Lifecycle filter**(v0.5 — backend ADR 006)| Public detail endpoint **必須**走 `whereLive` 4 條件:row 存在但 `deletedAt IS NOT NULL` / `archivedAt IS NOT NULL` / `publishStartAt > NOW()` / `publishEndAt <= NOW()` 任一成立 → **回 404,不回 200**;**禁止**洩漏「該 row 存在但不可見」的訊息。Project / SaleItem 額外:**parent Charity 必須也通過 `whereLive`**(Cascading visibility,ADR 006 §3),否則同樣 404 |
| Cache-Control(2xx)| `private, max-age=0, must-revalidate`(同 spec 016 §8)|
| **Cache-Control(404)**(v0.6 — B3)| `no-store`(spec 005 已預設,本 spec 顯式重申)。**理由**:cascading visibility(ADR 006 §3)會讓「Charity 合約過期 → 子表 404」與「續約 → 子表 200」反覆切換,client / CDN 若 cache 404 5 秒就會看到「續約完還是 404」的鬼故事;同樣 `archivedAt` toggle 也適用。Detail endpoint 的 404 永遠不可 cache |
| ETag(2xx)| `"<sha256(id + updatedAt + charity.updatedAt for nested + locale)前 16 字元>"`;`If-None-Match` 命中回 304(**v0.3 加入 locale** 避免 zh/en 互蓋)。**v0.6 — 404 response 不簽發 ETag**(避免 archived row 重新發布後舊 304 卡掉新內容,§7 已有測試)|
| **Accept-Language**(v0.3)| `zh-TW` / `en`;規則同 spec 016 §4.1.1;response 各 `name` / `description` / `content` 走 fallback `XxxEn ?? Xxx`;`Content-Language` 必有;`Vary: Accept-Language` 必有 |
| **圖片 URL**(v0.4)| DB 存 `logoKey` / `coverImageKey`(S3 key,spec 015 v0.8);response 仍回 `logoUrl` / `coverImageUrl`(完整 URL),由 spec 018 `objectUrl(key)` 拼接。換 CDN / bucket → 改 env(`S3_PUBLIC_URL_BASE`)即可 |
| **空欄位處理**(v0.6)| 可選欄位無值 → 回 `null`,**key 永遠存在**(對齊 spec 009 §4.4 v0.2、spec 016 v0.13)。`contactPhone` / `contactEmail` / `officialWebsite` / `approvalNo` / `logoUrl` / `coverImageUrl` / `raisingApprovalNo` / `reliefApprovalNo` 全採此規約 |
| Rate-limit | 與 list endpoint **共用 bucket**(同 IP,所有 read endpoint);BFF 拓墣下的 key 規約見 spec 016 §10.1 v0.13 |
| CORS | public(同 spec 016 §9)|

> **v0.5 — Cascading visibility 在 detail 的意義**(ADR 006 §3):前端拿 list response 的 `id` 點進 detail 時,如果 Charity 合約剛好過期 / 被 archive / soft delete,detail endpoint **不可**回 200。一致地走 `whereLive` + parent `whereLive`,**沒走 helper = 安全漏洞**(下架的資料被 deep link 看到)。實作建議:在 `domain/donation-item/get-by-id.ts` 內 `findUnique({ where: { id, ...whereLive(now) } })`,parent 透過 `findFirst({ where: { id, charity: whereLive(now) } })` 一次撈。

---

## 3. `GET /v1/donation/charities/:id`

對應 IMG_4876。

### 3.1 Response(200)

```jsonc
{
  "id": "0e1b...c9",
  "name": "ACC 中華耆幼關懷協會",
  "description": "當你長大時,你會發現你有兩隻手,一隻用來幫助自己,一隻來幫助別人。…",
  "logoUrl": "https://cdn.example.com/charities/acc.png",

  // v0.6 新增欄位(基本資料區)
  "contactPhone": "02-66040024",
  "contactEmail": "serv.accofroc@gmail.com",
  "officialWebsite": "https://accofroc.org",
  "approvalNo": "台內團字第1110295700號",

  // M:N inflated(對應 IMG_4876 tag pills)
  "categories": [
    { "id": "...", "key": "child_care",         "displayName": "兒少照護" },
    { "id": "...", "key": "poverty_relief",     "displayName": "弱勢扶貧" },
    { "id": "...", "key": "disability_service", "displayName": "身心障礙服務" }
  ],

  "createdAt": "...",
  "updatedAt": "..."
}
```

### 3.2 欄位

| 欄位 | 必有 | 型別 | 說明 |
|---|---|---|---|
| 基本欄位(id / name / description / logoUrl / createdAt / updatedAt) | ✅ | 同 list | `logoUrl` 為 `string \| null`(無圖時 `null`,key 永遠存在,v0.6)|
| `contactPhone` | nullable | string \| null | 「02-66040024」;無值 `null` |
| `contactEmail` | nullable | string(email) \| null | |
| `officialWebsite` | nullable | string(URL) \| null | |
| `approvalNo` | nullable | string \| null | 「台內團字第1110295700號」 |
| `categories[].id` | ✅ | uuid | 對應 Category 表 |
| `categories[].key` | ✅ | string | program identifier(spec 015 §7.1) |
| `categories[].displayName` | ✅ | string | UI label |

> `categories` 為 inflated object array,不是 `string[]`。理由:詳情頁直接顯示 displayName,避免前端再 lookup;與 `/v1/donation/categories` 的 `displayOrder` 等 metadata 解耦。
> **v0.3 i18n**:`name` / `description` / `categories[].displayName` 依 `Accept-Language` 選欄位回傳;`en` 缺則 fallback 至 zh-TW。Category 16 筆 seed 100% 有 `displayNameEn`,實務上不會 fallback。

### 3.3 Prisma 查詢

**v0.5 — 必須走 `whereLive`**(backend ADR 006 §2):row 在 DB 中存在但 lifecycle filter 不通過 → 視為 404,**不**洩漏存在訊息。改用 `findFirst`(允許 compound where)而非 `findUnique`:

```ts
// v0.6 — import 路徑對齊 code(原 spec 寫 `@/domain/donation-item/where.js` 是過去構想,
// 實作落地在 lifecycle 子 domain)
import { whereLive } from '@/domain/lifecycle/index.js'

const c = await prisma.charity.findFirst({
  where: { id, ...whereLive(new Date()) },   // ← 4 條件全套
  include: {
    categories: {
      where: {
        category: { deletedAt: null, archivedAt: null },  // ← 字典本身也 live (spec 015 §3.3)
      },
      include: { category: true },
      orderBy: { category: { displayOrder: 'asc' } },
    },
  },
})
if (!c) throw new NotFoundError({ resource: 'charity', id, code: 'CHARITY_NOT_FOUND' })
return {
  ...c,
  categories: c.categories.map(jc => ({
    id: jc.category.id, key: jc.category.key, displayName: jc.category.displayName,
  })),
}
```

> Charity 不需要 cascade(它是最上層),`whereLive` 4 條件即可。Category 字典過濾在 `include.where` 內處理,避免讓 archived category 的 tag pill 漏出來。

---

## 4. `GET /v1/donation/donation-projects/:id`

對應 IMG_4883。

### 4.1 Response(200)

```jsonc
{
  "id": "...",
  "name": "【安居・專業・愛】 — 守護身障弱勢,共築安全專業家園勸募活動",
  "description": "勸募立案核准字號 衛部救字第1151361613號",
  "logoUrl": null,
  "coverImageUrl": "https://cdn.example.com/projects/.../cover.jpg",

  // v0.6 新增欄位
  "content": "圓夢守護 60 位心智障礙者的避風港,柏拉圖復康之家需要您的支持!【關於我們:他們一輩子的家】…",
  "raisingApprovalNo": "勸募立案核准字號 衛部救字第1151361613號",
  "reliefApprovalNo": "衛部救字第1151361613號",

  // nested charity(對應 IMG_4883「主辦團體卡片 + 查看團體 ›」)
  "charity": {
    "id": "0e1b...c9",
    "name": "財團法人宜蘭縣私立柏拉圖復康之家",
    "logoUrl": "https://cdn.example.com/charities/.../logo.png"
  },

  // 繼承自主辦團體(spec 015 §7.4 子表繼承)
  "categories": [
    { "id": "...", "key": "disability_service", "displayName": "身心障礙服務" },
    { "id": "...", "key": "poverty_relief",     "displayName": "弱勢扶貧" }
  ],

  "createdAt": "...",
  "updatedAt": "..."
}
```

### 4.2 欄位

| 欄位 | 必有 | 型別 | 說明 |
|---|---|---|---|
| 基本欄位(id / name / description / logoUrl / createdAt / updatedAt) | 同 list | | `logoUrl: string \| null` |
| `coverImageUrl` | nullable | string(URL) \| null | 詳情頁主視覺;無圖 `null` |
| `content` | ✅ | string(可空字串但通常非空) | 完整專案內容 |
| `raisingApprovalNo` | nullable | string \| null | 勸募立案核准字號 |
| `reliefApprovalNo` | nullable | string \| null | 衛部救字號 |
| `charity.id` | ✅ | uuid | 對應 `/v1/donation/charities/:id` |
| `charity.name` | ✅ | string | |
| `charity.logoUrl` | nullable | string(URL) \| null | |
| `categories` | ✅ | 同 §3.2 | 繼承自主辦團體;**空 array 合法**(主辦團體可未掛 category)|

> **v0.3 i18n**:`name` / `description` / `content` 都依 locale fallback。`charity.name` 同邏輯。`content` 為長文,在 `en` 缺翻譯時 fallback 中文,前端應理解可能混雜語系(極少數情境)。

### 4.3 Prisma 查詢

**v0.5 — 必須走 `whereLive` 並對 parent Charity 套 cascade**(backend ADR 006 §3):

```ts
// v0.6 — code 採用 `whereLiveWithParent(now)` 一個 helper 收掉「Project 自身 live
// + parent Charity 也 live」兩段條件,呼叫端不必自己拼 `charity: { is: whereLive(now) }`。
// 行為等價,可讀性 / 拼錯機率都優於分開寫。
import { whereLiveWithParent } from '@/domain/lifecycle/index.js'

const now = new Date()
const p = await prisma.donationProject.findFirst({
  where: { id, ...whereLiveWithParent(now) },   // ← Project + parent Charity 一次套
  include: {
    charity: {
      include: {
        categories: {
          where: {
            category: { deletedAt: null, archivedAt: null },
          },
          include: { category: true },
          orderBy: { category: { displayOrder: 'asc' } },
        },
      },
    },
  },
})
if (!p) throw new NotFoundError({ resource: 'donation-project', id, code: 'DONATION_PROJECT_NOT_FOUND' })
const { charity, ...rest } = p
return {
  ...rest,
  charity: { id: charity.id, name: charity.name, logoUrl: charity.logoUrl },
  categories: charity.categories.map(jc => ({
    id: jc.category.id, key: jc.category.key, displayName: jc.category.displayName,
  })),
}
```

> **語意**:若 Charity 合作合約剛過期(`publishEndAt < now`),旗下 Project 即使自身欄位全空也回 404 — 對 client 等同「找不到」,**不**洩漏「該 row 存在但合約過期」。續約後同一個 deep link 立刻 200。
>
> `categories` 取得來源**繼承自主辦團體**(spec 015 §7.4),與 Project 自身欄位無關。

---

## 5. `GET /v1/donation/sale-items/:id`

對應 IMG_4882。

### 5.1 Response(200)

```jsonc
{
  "id": "...",
  "name": "北歐天然 | 小型寵物魚油 2oz",
  "description": "選擇北歐天然 Nordic Naturals,就是支持一份善意的力量。",
  "logoUrl": null,
  "coverImageUrl": "https://cdn.example.com/items/.../cover.jpg",
  "priceTwd": 920,                                    // 必有

  "content": "每一筆愛購,我們將提撥約 30% 的金額,捐贈「台灣紅絲帶基金會」…",
  "raisingApprovalNo": "勸募立案核准字號 衛部救字第1141364521號",
  "reliefApprovalNo": "衛部救字第1141364521號",

  "charity": {
    "id": "0e1b...c9",
    "name": "財團法人台灣紅絲帶基金會",
    "logoUrl": "https://cdn.example.com/charities/.../logo.png"
  },

  "categories": [
    { "id": "...", "key": "special_medical",    "displayName": "特殊醫病" },
    { "id": "...", "key": "education_advocacy", "displayName": "教育議題提倡" },
    { "id": "...", "key": "poverty_relief",     "displayName": "弱勢扶貧" }
  ],

  "createdAt": "...",
  "updatedAt": "..."
}
```

### 5.2 欄位

| 欄位 | 必有 | 型別 | 說明 |
|---|---|---|---|
| 基本 + cover + content + 字號 + charity + categories | 同 §4.2 | | |
| `priceTwd` | ✅ | integer ≥ 0 | TWD 整數;list endpoint 已包含,detail 維持一致 |

### 5.3 Prisma 查詢

同 §4.3 把 `donationProject` 換成 `saleItem` — **同樣**用 `whereLiveWithParent(now)` helper(v0.6,原 v0.5 分開寫 `whereLive` + `charity: { is: whereLive(now) }` 已收成單一 helper,語意等價)。

---

## 6. 開放問題

### 6.1 cross-link 區資料

IMG_4876 公益團體介紹頁底部有「捐款專案」區(該團體的子表清單)。v0.1 由前端再呼一次 `GET /v1/donation/donation-projects?charityId=<id>&limit=10`。

如果想避免 round-trip,Charity detail 可加 `?include=recentProjects,recentItems` 嵌入前 N 筆。屬於 additive,不影響現有 contract。本 spec v0.1 暫不支援。

### 6.2 ETag 計算包含 nested charity 的 updatedAt

Project / SaleItem detail 的 `charity` 子物件變動(改名 / 改 logo)需讓 ETag 失效。v0.1 計算公式:`sha256(id + updatedAt + charity.updatedAt)` 前 16 字元。

### 6.3 `categories` inflated vs key-only

v0.1 回 inflated(`{ id, key, displayName }[]`)。如果未來想瘦身,可加 `?format=keys-only` 退回 `string[]`(key only)。

### 6.4 i18n fallback 透明度(v0.3)

API 回傳 `name: string`,client 無法分辨「拿到的是 en 還是 fallback zh-TW」。如果未來 UI 需要明顯標示「此內容尚未翻譯」(例如打灰、加 `[未譯]` tag),server 可加 `?include=langInfo` 回 `nameLocale: 'zh-TW' | 'en'`。本 v0.3 不支援(屬 additive)。

### 6.5 404 vs 200 + 空殼

不存在 → **404**(不同於 list 「filter 後沒結果」回 200)。語意:detail endpoint 是「對特定 entity 的存取」,不存在 = 找不到資源。

### 6.6 寫入端點

本 spec **不**包含 POST / PATCH / DELETE。作業無後台 UI,寫入靠 seed。

---

## 7. 測試矩陣

| 層 | 案例 | 期望 |
|---|---|---|
| unit | TypeBox schema parse Project detail response | 對 |
| integration | `GET /v1/donation/charities/:id` 帶齊聯絡欄位的 seed → response 完整 | 對 |
| integration | `GET /v1/donation/charities/:id` 部分聯絡欄位為 DB null → response 對應欄位**回 `null`,key 仍出現**(v0.6 — spec 009 §4.4 v0.2)| 對 |
| integration | `GET /v1/donation/donation-projects/:id` nested charity inflated 且 `categories` 繼承自主辦團體 | 對 |
| integration | `GET /v1/donation/sale-items/:id` `priceTwd` 為 0 → 回 200(0 為合法價格) | 對 |
| integration | 三 endpoint 帶 invalid uuid → 400 `VALIDATION_FAILED`(v0.6) | 對 |
| integration | 三 endpoint 帶不存在 uuid → 404 對應 code | 對 |
| integration | ETag 命中 `If-None-Match` → 304 | 對 |
| integration | 改主辦團體名稱 → Project detail ETag 變動 → 304 不再命中 | 對 |
| integration | rate-limit 與 list endpoint 共用 bucket(同 IP 算入同一上限) | 對 |
| integration | **v0.3 i18n**:`Accept-Language: en` 的 detail response 各 `name` / `description` / `content` 為英文(有翻譯時);缺英文時 fallback zh-TW,且 `Content-Language: zh-TW` | 對 |
| integration | **v0.3 i18n**:同 charity 的 `zh-TW` 與 `en` 兩次 GET 的 ETag **不同**(locale 進入 ETag 計算)| 對 |
| integration | **v0.3 i18n**:nested `charity` 物件的 `name` 也走 fallback | 對 |
| integration | **v0.5 archived row → 404**:seed Charity / Project / SaleItem `archivedAt = past`,detail endpoint 回 `*_NOT_FOUND`(**不**洩漏「row 存在但已封存」)| 對 |
| integration | **v0.5 deleted row → 404**:`deletedAt = past` 同樣回 404 | 對 |
| integration | **v0.5 publishStartAt 未到 → 404**:`publishStartAt = future` 的 row 當下 404;fake clock 推到 `publishStartAt + 1s` 後同 id 回 200 | 對 |
| integration | **v0.5 publishEndAt 已過 → 404**:`publishEndAt = past` 同樣 404 | 對 |
| integration | **v0.5 Cascading visibility(Project 端,ADR 006 §3)**:Charity A `publishEndAt = past`(合約過期),A 旗下 Project P1 自身欄位全空 — `GET /v1/donation/donation-projects/P1` 回 `DONATION_PROJECT_NOT_FOUND`(404),**不**洩漏「P1 存在但 parent 過合約」 | 對 |
| integration | **v0.5 Cascading visibility — 反向恢復**:接續上一條,A.publishEndAt 設回未來,同 id deep link 回 200 | 對 |
| integration | **v0.5 Cascading visibility(SaleItem 端)**:Charity B `archivedAt = past`,旗下 SaleItem S1 自身全空 — `GET /v1/donation/sale-items/S1` 回 404 | 對 |
| integration | **v0.5 Cascading visibility — archived category 隱藏**:detail response 內的 `categories` 不含 `archivedAt` / `deletedAt` 非空的 Category(透過 `include.where` 過濾)| 對 |
| integration | **v0.5 ETag 不對 404 row 簽發**:archived / deleted row 的 404 response **無** ETag header(避免 client cache 後續續恢復後的 200 被舊 304 卡掉)| 對 |
| integration | **v0.6 404 response Cache-Control: no-store**(B3):上述 archived / deleted / publish window 外 / cascading parent 過期等四條 404 情境,response 的 `Cache-Control` 必含 `no-store`(避免 CDN cache 過期 row 的 404,續約 / unarchive 後仍回 404)| 對 |
| e2e | 前端 charity detail page 直接渲染 | 對 |
| e2e | 前端 project detail 點主辦團體 chip → 跳對應 charity detail | 對 |

---

## 8. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-14 | 初版:從 spec 016 §7 拆出 detail endpoint 的詳細 shape。對應截圖補件(IMG_4876 / 4883 / 4882)的 detail 欄位 |
| 0.2 | 2026-06-14 | 三個 detail endpoint 加 `/donation/` 前綴(同步 spec 016 v0.7):`GET /v1/donation/charities/:id`、`GET /v1/donation/donation-projects/:id`、`GET /v1/donation/sale-items/:id` |
| 0.3 | 2026-06-14 | 引入 i18n(backend ADR 004):(1) §2 共通規則加 `Accept-Language` 行為;(2) ETag 公式包含 locale(避免 zh/en 互蓋);(3) `Content-Language` / `Vary` header 必有;(4) §3 ~ §5 各 response shape 不變,fallback 在 server 端完成;(5) Category inflated `displayName` 依 locale 切換(seed 100% backfill 不會 fallback);(6) §6.4 新增 i18n fallback 透明度開放問題(`?include=langInfo`);(7) §7 補 3 條 i18n 測試 |
| 0.4 | 2026-06-14 | 同步 spec 015 v0.8 / spec 018 v0.2:detail response 中的 `logoUrl` / `coverImageUrl` / `charity.logoUrl` 由 server 端 `objectUrl(key)` 拼接(DB 存 key,**response shape 對 client 不變**)。§2 共通規則加註圖片 URL 拼接來源;§7 不必新測試(URL 完整性已在 spec 018 §12 testcontainer e2e 覆蓋)|
| 0.5 | 2026-06-14 | Entity lifecycle 落實到 detail endpoint(**backend ADR 006 / spec 015 v0.9 / spec 016 v0.11**):(1) §2 共通規則加「Lifecycle filter」行 — public detail 必須走 `whereLive` 4 條件,任一不通過回 404 不洩漏存在;(2) Project / SaleItem 額外 cascading visibility — parent Charity 也必須通過 `whereLive`,否則同樣 404;(3) §2 末加 implementation hint;(4) §3.3 / §4.3 / §5.3 Prisma 查詢範例改用 `findFirst` + `whereLive(now)`,Project / SaleItem 加 `charity: { is: whereLive(now) }` cascade,Category include 加 `archivedAt: null, deletedAt: null` 過濾;(5) §7 補 8 條 lifecycle 整合測試(4 種 lifecycle 路徑各 → 404、Cascading visibility Project / SaleItem 各 + 反向恢復、archived category 不出現在 categories 內、ETag 不對 404 row 簽發)|
| 0.6 | 2026-06-14 | 與實作對齊 + best practice 補強(對齊 spec 009 v0.2 / spec 016 v0.13):**(A 類 drift)** (1) §2 / §7 `VALIDATION_ERROR` → `VALIDATION_FAILED`(spec 005 §4.2 字典為命名權威,過去版本拼成 `_ERROR` 是 drift);(2) §2 / §3.2 / §4.2 / §5.2 / §7 可選欄位無值改為「回 `null`,key 永遠存在」 — 對齊 `src/schemas/donation-item/detail.ts` 既有 `Type.Union([String, Null])` schema 與 spec 009 v0.2;(3) §3.3 / §4.3 / §5.3 import 路徑 `@/domain/donation-item/where.js` → `@/domain/lifecycle/index.js`(對齊 code);(4) §4.3 / §5.3 改用 `whereLiveWithParent(now)` 單一 helper(語意等價於 `whereLive + charity: { is: whereLive(now) }`,可讀性與正確性都優於分開拼);(5) §3.3 `NotFoundError` 範例補上 `{ resource, id, code }` payload(對齊實作)。**(B 類 best practice)** (6) §2 新增 `Cache-Control(404): no-store`(B3) — cascading visibility 與 lifecycle window 會讓 404 ↔ 200 反覆切換,client / CDN 不可 cache 404;§7 補 1 條對應測試 |
