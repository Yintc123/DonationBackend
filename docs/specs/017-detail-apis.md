# Spec 017:詳情頁 API(Charity / DonationProject / SaleItem detail)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.4 |
| 日期 | 2026-06-14 |
| 適用範圍 | `backend/src/routes/v1/donation/charities/get-by-id.ts`、`backend/src/routes/v1/donation/donation-projects/get-by-id.ts`、`backend/src/routes/v1/donation/sale-items/get-by-id.ts`、`backend/src/schemas/donation-item/detail.ts` |
| 相關 ADR | 同 spec 016(專案級 002 Fastify schema-driven、007 Prisma;backend 002 charity-category-model、**backend 004 i18n-storage-model**)|
| 相關 spec | `015-charity-data-model.md` v0.6(資料來源)、`016-charity-list-api.md` v0.6(list endpoint + 共用 contract 規約)、`009-api-response-and-http-status.md`(status / header)、`005-error-handling.md`(錯誤回應)|
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
| `:id` 非 uuid → 400 | `VALIDATION_ERROR` |
| 找不到 → 404 | `CHARITY_NOT_FOUND` / `DONATION_PROJECT_NOT_FOUND` / `SALE_ITEM_NOT_FOUND` |
| Cache-Control | `private, max-age=0, must-revalidate`(同 spec 016 §8)|
| ETag | `"<sha256(id + updatedAt + charity.updatedAt for nested + locale)前 16 字元>"`;`If-None-Match` 命中回 304(**v0.3 加入 locale** 避免 zh/en 互蓋)|
| **Accept-Language**(v0.3)| `zh-TW` / `en`;規則同 spec 016 §4.1.1;response 各 `name` / `description` / `content` 走 fallback `XxxEn ?? Xxx`;`Content-Language` 必有;`Vary: Accept-Language` 必有 |
| **圖片 URL**(v0.4)| DB 存 `logoKey` / `coverImageKey`(S3 key,spec 015 v0.8);response 仍回 `logoUrl` / `coverImageUrl`(完整 URL),由 spec 018 `objectUrl(key)` 拼接。換 CDN / bucket → 改 env(`S3_PUBLIC_URL_BASE`)即可 |
| Rate-limit | 與 list endpoint **共用 bucket**(同 IP,所有 read endpoint)|
| CORS | public(同 spec 016 §9)|

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
| 基本欄位(id / name / description / logoUrl / createdAt / updatedAt) | ✅ | 同 list | |
| `contactPhone` | optional | string | 「02-66040024」 |
| `contactEmail` | optional | string(email) | |
| `officialWebsite` | optional | string(URL) | |
| `approvalNo` | optional | string | 「台內團字第1110295700號」 |
| `categories[].id` | ✅ | uuid | 對應 Category 表 |
| `categories[].key` | ✅ | string | program identifier(spec 015 §7.1) |
| `categories[].displayName` | ✅ | string | UI label |

> `categories` 為 inflated object array,不是 `string[]`。理由:詳情頁直接顯示 displayName,避免前端再 lookup;與 `/v1/donation/categories` 的 `displayOrder` 等 metadata 解耦。
> **v0.3 i18n**:`name` / `description` / `categories[].displayName` 依 `Accept-Language` 選欄位回傳;`en` 缺則 fallback 至 zh-TW。Category 16 筆 seed 100% 有 `displayNameEn`,實務上不會 fallback。

### 3.3 Prisma 查詢

```ts
const c = await prisma.charity.findUnique({
  where: { id },
  include: {
    categories: {
      include: { category: true },
      orderBy: { category: { displayOrder: 'asc' } },
    },
  },
})
if (!c) throw new NotFoundError('CHARITY_NOT_FOUND')
return {
  ...c,
  categories: c.categories.map(jc => ({
    id: jc.category.id, key: jc.category.key, displayName: jc.category.displayName,
  })),
}
```

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
| 基本欄位(id / name / description / logoUrl / createdAt / updatedAt) | 同 list | | |
| `coverImageUrl` | optional | string(URL) | 詳情頁主視覺 |
| `content` | ✅ | string(可空字串但通常非空) | 完整專案內容 |
| `raisingApprovalNo` | optional | string | 勸募立案核准字號 |
| `reliefApprovalNo` | optional | string | 衛部救字號 |
| `charity.id` | ✅ | uuid | 對應 `/v1/donation/charities/:id` |
| `charity.name` | ✅ | string | |
| `charity.logoUrl` | optional | string(URL) | |
| `categories` | ✅ | 同 §3.2 | 繼承自主辦團體;**空 array 合法**(主辦團體可未掛 category)|

> **v0.3 i18n**:`name` / `description` / `content` 都依 locale fallback。`charity.name` 同邏輯。`content` 為長文,在 `en` 缺翻譯時 fallback 中文,前端應理解可能混雜語系(極少數情境)。

### 4.3 Prisma 查詢

```ts
const p = await prisma.donationProject.findUnique({
  where: { id },
  include: {
    charity: {
      include: {
        categories: {
          include: { category: true },
          orderBy: { category: { displayOrder: 'asc' } },
        },
      },
    },
  },
})
if (!p) throw new NotFoundError('DONATION_PROJECT_NOT_FOUND')
const { charity, ...rest } = p
return {
  ...rest,
  charity: { id: charity.id, name: charity.name, logoUrl: charity.logoUrl },
  categories: charity.categories.map(jc => ({
    id: jc.category.id, key: jc.category.key, displayName: jc.category.displayName,
  })),
}
```

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

同 §4.3 把 `donationProject` 換成 `saleItem`。

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
| integration | `GET /v1/donation/charities/:id` 部分聯絡欄位為 null → response 省略 key(spec 009 §4.4) | 對 |
| integration | `GET /v1/donation/donation-projects/:id` nested charity inflated 且 `categories` 繼承自主辦團體 | 對 |
| integration | `GET /v1/donation/sale-items/:id` `priceTwd` 為 0 → 回 200(0 為合法價格) | 對 |
| integration | 三 endpoint 帶 invalid uuid → 400 `VALIDATION_ERROR` | 對 |
| integration | 三 endpoint 帶不存在 uuid → 404 對應 code | 對 |
| integration | ETag 命中 `If-None-Match` → 304 | 對 |
| integration | 改主辦團體名稱 → Project detail ETag 變動 → 304 不再命中 | 對 |
| integration | rate-limit 與 list endpoint 共用 bucket(同 IP 算入同一上限) | 對 |
| integration | **v0.3 i18n**:`Accept-Language: en` 的 detail response 各 `name` / `description` / `content` 為英文(有翻譯時);缺英文時 fallback zh-TW,且 `Content-Language: zh-TW` | 對 |
| integration | **v0.3 i18n**:同 charity 的 `zh-TW` 與 `en` 兩次 GET 的 ETag **不同**(locale 進入 ETag 計算)| 對 |
| integration | **v0.3 i18n**:nested `charity` 物件的 `name` 也走 fallback | 對 |
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
