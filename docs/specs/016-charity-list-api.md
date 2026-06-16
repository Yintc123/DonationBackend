# Spec 016:捐款項目列表 / 搜尋 API(Charity / DonationProject / SaleItem / Category)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.15 |
| 日期 | 2026-06-14 |
| 適用範圍 | `backend/src/routes/v1/donation/charities/*`、`backend/src/routes/v1/donation/donation-projects/*`、`backend/src/routes/v1/donation/sale-items/*`、`backend/src/routes/v1/donation/categories/*`、`backend/src/domain/donation-item/*`、`backend/src/domain/category/*`、`backend/src/schemas/donation-item/*`、`backend/src/schemas/category/*` |
| 相關 ADR | `../../docs/decisions/002-backend-framework.md`(專案級 — Fastify schema-driven)、`../../docs/decisions/007-orm-prisma.md`(專案級)、`../decisions/001-donation-item-relations.md`(backend 級 — `?charityId=` 過濾)、`../decisions/002-charity-category-model.md`(backend 級 — `?category=<key>` 過濾、`/v1/donation/categories` 端點、子表繼承查詢)、`../decisions/004-i18n-storage-model.md`(backend 級 — `Accept-Language` request header + fallback 語意)、`../decisions/006-lifecycle-fields-and-cascading-visibility.md`(backend 級 — **v0.11 起所有 public list query 必須走 `whereLive` + Project / SaleItem cascade parent Charity 的 `whereLive`**)|
| 相關 spec | `015-charity-data-model.md`(資料來源)、`009-api-response-and-http-status.md`(分頁 / status / header 規約)、`005-error-handling.md`(錯誤回應)、`010-rate-limit-module.md`、`012-cors-and-security-headers.md`(public CORS) |
| 設計來源 | Figma file key `0kx2Ne2rvndhfVr3uVUwad`,frame「分類列表 - 全部團體」/「分類列表 - 搜尋中」/「搜尋 - No Result - 公益團體」 |

---

## 1. 目的與範圍

> **URL prefix(spec 023 §2 已落地)**:本 spec 列的 endpoint path **不含 surface prefix**。實際 client URL 依 surface 加前綴:
> - Public read endpoints → `/user/v{N}/...`(spec 023 §2.2;當前 `v1`)
> - Admin write endpoints → `/cms/...`(spec 023 §2.3,scope-level `requireAdmin` 由 `/cms` plugin attach)
> - Auth endpoints → `/auth/...`(spec 023 §2.1,不版本化)
>
> Endpoint URL 完整 mapping 表見 spec 023 §2.4。

### 1.1 目的

把 spec 015 的三個 entity(`Charity` / `DonationProject` / `SaleItem`)透過符合 spec 009 的對外 API 暴露給 BFF / 前端,支援 Figma 三個 tab 各自的:

- 卡片列表(無限滾動)
- 關鍵字搜尋(name + description)
- 分類 filter(預留,參數已開放)

### 1.2 In scope

- `GET /v1/donation/charities` / `GET /v1/donation/donation-projects` / `GET /v1/donation/sale-items`(列表 + 搜尋 + filter + 分頁)
- `GET /v1/donation/{resource}/:id`(單筆查詢,非作業要求但低成本附帶)
- **`GET /v1/donation/categories`**(分類字典,給 dropdown 用)
- 三 list endpoint 共用的 query / response shape 與 schema 抽象
- 查詢參數契約、錯誤碼、cache 策略、rate-limit / CORS / auth 邊界
- Project / SaleItem 經由主表(Charity)的 categories 做 filter(子表繼承,§4.6)

### 1.3 Out of scope

- **建立 / 更新 / 刪除**:本作業無後台 UI,不暴露寫入端點(seed 走 Prisma)
- **個人化排序 / 推薦演算法**:Figma 無相關 UI
- **金流、捐款交易、訂單**:整體 backend 範圍外

---

## 2. 設計原則

1. **三 endpoint 共用同一份 schema 抽象**:query / response shape **完全相同**(對應 spec 015 §1 entity 同結構決策)。實作層用 generic 工廠函式,避免三套 boilerplate。
2. **完全沿用 spec 009**:cursor 分頁、no envelope、HTTP status 字典、`X-Request-Id`、`Idempotency-Key` 都不重新定義,只指出本端點如何套用。
3. **每 entity 一個 URL namespace**,不混進同一個 endpoint 用 `?type=` 區分:
   - 對 client / OpenAPI / 快取 / rate-limit 更乾淨
   - 與 spec 015 的 3 張獨立表 1:1 對齊
4. **搜尋無結果 ≠ 錯誤**:Figma「No Result」frame 仍是 200 + 空 list。前端切換 empty state 由 `items.length === 0` 判斷,**不**靠 status code。
5. **schema-first**:request / response 用 TypeBox 宣告,handler 從 schema 推導型別(ADR 002)。
6. **多語系透過 `Accept-Language` request header**(backend ADR 004):server 從 header 選 zh-TW 或 en 欄位,**response shape 不變**(client 永遠收到 `name: string`,英文缺則 fallback 主語);搜尋的 `q` 對應 locale 的 `name + description` 欄位做 ILIKE。
7. **圖片 URL 由 server 端拼接**(spec 018 v0.2):DB 存 `logoKey` / `coverImageKey`(S3 key),response 中的 `logoUrl` / `coverImageUrl` 由 `objectUrl(key)` 從 env-controlled base URL 拼。**response shape 對 client 不變**(收到的仍是完整 URL);未來換 CDN / 換 bucket → 改 env 即可,不必 backfill DB。
8. **Entity lifecycle 預設 filter**(v0.11 — backend ADR 006):所有 list / detail 公開 endpoint 必須走 service-layer `whereLive(now)` helper(4 條件:`deletedAt IS NULL` / `archivedAt IS NULL` / `publishStartAt 在過去 OR null` / `publishEndAt 在未來 OR null`),**禁止**route handler 自拼。Project / SaleItem 額外**對 parent Charity 套同樣 helper**(cascading visibility);Charity 合作合約過期 → 旗下所有子表自動消失,續約自動恢復,**禁止**用 batch job 同步狀態(避免續約倒回的複雜度)。

---

## 3. 端點清單

| 方法 | Path | 對應 entity | 用途 | Auth |
|---|---|---|---|---|
| `GET` | `/v1/donation/charities` | `Charity` | 列表 / 搜尋 / filter | public |
| `GET` | `/v1/donation/charities/:id` | `Charity` | 單筆查詢 | public |
| `GET` | `/v1/donation/donation-projects` | `DonationProject` | 列表 / 搜尋 / filter | public |
| `GET` | `/v1/donation/donation-projects/:id` | `DonationProject` | 單筆查詢 | public |
| `GET` | `/v1/donation/sale-items` | `SaleItem` | 列表 / 搜尋 / filter | public |
| `GET` | `/v1/donation/sale-items/:id` | `SaleItem` | 單筆查詢 | public |
| `GET` | `/v1/donation/categories` | `Category` | 分類字典(dropdown)| public |

> 「public」= 不需登入,不受 spec 007 auth middleware 影響。Rate-limit 仍套用(§10)。
> 路徑用 **kebab-case 複數**,呼應 spec 009 的 `/v1/<resource>` 慣例。

---

## 4. 共用列表契約

以下 §4 對三個 list endpoint(`/v1/donation/charities`、`/v1/donation/donation-projects`、`/v1/donation/sale-items`)**完全相同**。三 endpoint 不再各自展開,避免規格重複。

### 4.1 Request

```http
GET /v1/donation/{resource}?q=<keyword>&category=<key>&cursor=<opaque>&limit=<n>&sort=<spec> HTTP/1.1
Accept: application/json
Accept-Language: zh-TW           # 或 en,缺則預設 zh-TW
```

### 4.1.1 Accept-Language 語意(v0.8)

| 收到的 header | server 行為 |
|---|---|
| `Accept-Language: zh-TW`(或缺 / 為空)| 用中文欄位(`name` / `description` / `Category.displayName`)做 search + response |
| `Accept-Language: en` | 用英文欄位(`name_en` / `description_en` / `displayNameEn`),response 層 fallback `name_en ?? name`(若 en 為 NULL 就退回中文,避免空白)|
| `Accept-Language: ja`(未支援的 locale)| **不**回 400,fallback 視為 `zh-TW` 處理(REST 慣例:未支援 locale 不該破壞請求)|
| `Accept-Language: en-US, en;q=0.9, zh-TW;q=0.5`(quality value)| 取第一個支援的 locale;同例 → `en` |

> 搜尋的 `q` **只命中對應 locale 的欄位**(`Accept-Language: en` 的 `q=stray` 找 `name_en + description_en`,不混 zh-TW);response 層的 fallback 是顯示問題,不影響搜尋集合。

### 4.2 Query 參數

| 參數 | 必填 | 預設 | 上限 / 規則 | 說明 |
|---|---|---|---|---|
| `q` | 否 | — | **NFC 正規化** + trim 後 1 ~ 80 字(JS string `length`,即 UTF-16 code unit)| 關鍵字。對 `name` 與 `description` ILIKE 子字串比對(spec 015 §4.2 trigram GIN)。**v0.13 — NFC 正規化(B2)**:不同輸入法 / 平台會送出 NFC vs NFD 不同 byte 序列(同顯示文字),server 收進後一律 `String.prototype.normalize('NFC')` 再 trim、計長度、丟 Prisma;否則「ç」/「c + ̧」之類組合會 ILIKE 漏命中 |
| `category` | 否 | — | `CategoryKey`(16 個白名單之一,spec 015 §7.1)| 分類過濾;**用 application-level key 而非 UUID**(backend ADR 002 v0.2 §結果)。Charity 直接 JOIN `charity_categories` + `categories` 拿 key;Project / SaleItem 透過主表 JOIN(§4.6 子表繼承) |
| `cursor` | 否 | — | opaque base64url 字串 | 由 server 上一頁 `pageInfo.nextCursor` 提供 |
| `limit` | 否 | `10` | `1` ~ `50` | 每頁筆數;預設 `10` 對齊 brief v0.3「每 tab 一開始抓 10 筆」;spec 009 §5.2 上限 100,本端點再收緊到 50 |

> **v0.12 — 移除 `sort` 參數**:v0.11 §4.5 已凍結排序為 `display_order ASC, created_at DESC, id DESC`(backend ADR 006 §4 強制),route handler 不可覆寫。原 v0.10 之前的 `?sort=createdAt:asc` 等變體**不再支援**。需要排序變化時走 spec + ADR 流程。

`/v1/donation/donation-projects` 與 `/v1/donation/sale-items` 額外可接受:

| 參數 | 必填 | 規則 | 說明 |
|---|---|---|---|
| `charityId` | 否 | uuid | 過濾「某團體底下的專案 / 商品」(對應 spec 015 §4.1 `(charityId)` index) |

`/v1/donation/charities` 不支援 `charityId`(自己沒有此欄位)。

三 endpoint 都支援 `category`(語意上 Project / SaleItem 繼承主辦團體的分類)。

### 4.3 Response(200 OK)

三 endpoint 的 response shape 對應 spec 015 v0.6 的三 entity,差別在於 list 卡片需要的欄位 per-tab 不同(對應 frontend 003e1/e2/e3 卡片 layout):

**`/v1/donation/charities`(對應 IMG_4875 公益團體卡片)**:

```jsonc
{
  "items": [
    {
      "id": "0e1b...c9",
      "name": "ACC 中華耆幼關懷協會",
      "description": "你身上有光,能照亮不確定的黑暗",
      "logoUrl": "https://cdn.example.com/charities/acc.png",
      "createdAt": "2026-06-14T01:23:45.678Z",
      "updatedAt": "2026-06-14T01:23:45.678Z"
    }
  ],
  "pageInfo": { "nextCursor": "...", "hasMore": true }
}
```

**`/v1/donation/donation-projects`(對應 IMG_4880 捐款專案卡片)**:

```jsonc
{
  "items": [
    {
      "id": "...",
      "charityId": "0e1b...c9",                    // FK 到 Charity
      "charityName": "財團法人宜蘭縣私立柏拉圖復康之家",  // v0.6 embed,卡片直接顯示主辦團體名
      "name": "【安居・專業・愛】 — 守護身障弱勢…",
      "description": "圓夢守護 60 位心智障礙者的避風港…",
      "logoUrl": "https://cdn.example.com/projects/.../logo.png",
      "coverImageUrl": "https://cdn.example.com/projects/.../cover.jpg",  // v0.6 卡片主視覺
      "categories": ["disability_service", "poverty_relief"],             // v0.6 卡片底部 tags(繼承自主辦團體)
      "createdAt": "2026-06-14T01:23:45.678Z",
      "updatedAt": "2026-06-14T01:23:45.678Z"
    }
  ],
  "pageInfo": { "nextCursor": "...", "hasMore": true }
}
```

**`/v1/donation/sale-items`(對應 IMG_4877 義賣商品卡片)**:

```jsonc
{
  "items": [
    {
      "id": "...",
      "charityId": "0e1b...c9",
      "charityName": "財團法人台灣紅絲帶基金會",
      "name": "北歐天然 | 小型寵物魚油 2oz",
      "description": "選擇北歐天然 Nordic Naturals…",
      "logoUrl": "https://cdn.example.com/items/.../thumb.png",
      "coverImageUrl": "https://cdn.example.com/items/.../cover.jpg",
      "priceTwd": 920,                              // v0.6 卡片紅色加重顯示
      "categories": ["special_medical", "education_advocacy", "poverty_relief"],
      "createdAt": "2026-06-14T01:23:45.678Z",
      "updatedAt": "2026-06-14T01:23:45.678Z"
    }
  ],
  "pageInfo": { "nextCursor": "...", "hasMore": true }
}
```

> v0.6 新增 `charityName` / `coverImageUrl` / `priceTwd` / `categories` 是 **additive**(對齊截圖補件揭露的卡片欄位)。`charityName` 由 backend JOIN charity 表後 inline,避免前端 N+1。`categories` 是繼承自主辦團體(Project / SaleItem 不自存)。

### 4.4 回應欄位

| 欄位 | endpoint | 必有 | 型別 | 說明 |
|---|---|---|---|---|
| `items[].id` | all | ✅ | uuid string | spec 015 主鍵 |
| `items[].name` | all | ✅ | string | 完整名稱 |
| `items[].description` | all | ✅ | string | 完整簡介(無截斷;前端 CSS 控制行數)|
| `items[].logoUrl` | all | nullable | string (URL) \| null | 無 logo 時回 `null`,**key 永遠存在**(v0.13 — spec 009 §4.4 v0.2 統一 null 語意)|
| `items[].createdAt` / `updatedAt` | all | ✅ | ISO 8601 UTC | |
| `items[].charityId` | donation-projects / sale-items | ✅ | uuid string | FK |
| `items[].charityName` | donation-projects / sale-items | ✅ | string | embed,避免 N+1 |
| `items[].coverImageUrl` | donation-projects / sale-items | nullable | string (URL) \| null | 卡片主視覺;無圖時回 `null`(同上)|
| `items[].priceTwd` | sale-items | ✅ | integer ≥ 0 | TWD 整數 |
| `items[].categories` | all (v0.13) | ✅ | `InflatedCategory[]` | `{ id, key, displayName }[]` — Charity 自身、Project / SaleItem 繼承自主辦團體(可空 array)。**v0.13:Charity endpoint 也加入此欄位**(對齊實作 `CharityListItem` schema,並與 detail `categories` 一致;之前 §4.4 註記「未來 `?include=categories`」已實質落地)|
| `pageInfo.nextCursor` | all | nullable | string | 最後一頁為 `null` |
| `pageInfo.hasMore` | all | ✅ | boolean | `false` 時 `nextCursor` 必為 `null` |

> v0.13 — Charity list item 已嵌入 `categories`(對齊 detail 與實作 schema);Project / SaleItem 的 `categories` 仍由主辦團體繼承。原 `?include=categories` 開放問題已實質吸收,標記為 resolved。

### 4.5 排序與 cursor

- **v0.11 預設變更**(backend ADR 006 §4):`ORDER BY display_order ASC, created_at DESC, id DESC`
  - `displayOrder` 為主要排序鍵(admin 手動置頂機制);未指定 = `0`,fallback 到 `createdAt`
  - 三 list endpoint 共用此排序,**route handler 不可覆寫**;若日後業務要新排序欄位,在 spec 改完後同步 ADR 006
- Tiebreaker:`id` 方向與**第二級**排序(`createdAt`)相同(spec 009 §5.4)
- cursor payload **v0.11 起包三段值**(原本只有 `lastSortValue` + `lastId`):
- cursor payload(client 視為 opaque):

```ts
// v0.11 — 三段 cursor 對應 displayOrder + createdAt + id
type CursorPayload = {
  lastDisplayOrder: number; // int
  lastCreatedAt: string;    // ISO 8601
  lastId: string;           // uuid
};
// base64url(JSON.stringify(payload))
```

- cursor 解碼失敗 → 400 `PAGINATION_CURSOR_INVALID`
- cursor 內 `lastId` 已被 soft delete(`deletedAt` 非空)→ **不**回錯,用 `(lastDisplayOrder, lastCreatedAt)` 續查(spec 009 §5.4)
- cursor 內 `lastId` row 的 `displayOrder` 或 `createdAt` 已被 admin 改值 → 結果順序可能稍跳,**接受**(cursor 不是 transactional snapshot;Figma 沒有「絕對穩定 cursor」需求)

### 4.6 搜尋語意

- `q` 與 `category`(與 `charityId`,Project / SaleItem 時)為 **AND** 關係
- `q` 對 `name` / `description` 為 OR
- **v0.11 — 所有 SQL 範例必須先套 `whereLive`**(backend ADR 006 §2):4 條件 `deleted_at IS NULL AND archived_at IS NULL AND (publish_start_at IS NULL OR publish_start_at <= NOW()) AND (publish_end_at IS NULL OR publish_end_at > NOW())`。下方 SQL 範例已內嵌;**禁止** route 自拼,**必須**走 service-layer `whereLive(now)` helper

**Charity endpoint 的 filter 查詢(`zh-TW` locale):**
```sql
SELECT c.*
FROM charities c
[JOIN charity_categories cc ON cc.charity_id = c.id]                 -- 僅當有 category
[JOIN categories cat ON cat.id = cc.category_id AND cat.key = $key]  -- key 比對(categories.key 為 unique index)
WHERE
  -- v0.11 — whereLive (ADR 006 §2)
  c.deleted_at IS NULL
  AND c.archived_at IS NULL
  AND (c.publish_start_at IS NULL OR c.publish_start_at <= NOW())
  AND (c.publish_end_at   IS NULL OR c.publish_end_at   >  NOW())
  -- v0.11 — Category 自己也要 live(若有 category filter)
  [AND cat.deleted_at IS NULL AND cat.archived_at IS NULL]
  -- 原 q + category filter
  AND (c.name ILIKE '%' || $q || '%' OR c.description ILIKE '%' || $q || '%')
ORDER BY c.display_order ASC, c.created_at DESC, c.id DESC          -- v0.11 — 排序加 displayOrder
LIMIT $limit
```

> **效能說明**:`categories.key` 為 `@unique` B-tree index(spec 015 §3 model),16 筆字典下 lookup 為 O(log n) ≈ 常數時間;與直接用 UUID(`WHERE cc.category_id = $uuid`)的成本差異 < 0.1ms,實質無感。Service 層也可改用 in-memory cache(啟動時把 16 筆 key→id 灌進 `Map<string, string>`),完全省掉 JOIN — 三 list endpoint 共用同一份 cache。

**`en` locale 改打英文欄位**:`name` → `name_en`、`description` → `description_en`(其他不變)。Service 層根據解析後的 locale 動態切欄。

**Project / SaleItem endpoint 的 filter 查詢(子表繼承 + cascading visibility):**
```sql
SELECT p.*
FROM donation_projects p   -- 或 sale_items
-- v0.11 — Cascading visibility: parent Charity 必須也 live(ADR 006 §3)
JOIN charities c ON c.id = p.charity_id
[JOIN charity_categories cc ON cc.charity_id = p.charity_id]
[JOIN categories cat ON cat.id = cc.category_id AND cat.key = $key]
WHERE
  -- v0.11 — whereLive on Project / SaleItem
  p.deleted_at IS NULL
  AND p.archived_at IS NULL
  AND (p.publish_start_at IS NULL OR p.publish_start_at <= NOW())
  AND (p.publish_end_at   IS NULL OR p.publish_end_at   >  NOW())
  -- v0.11 — whereLive on parent Charity(Cascading visibility 主路徑)
  AND c.deleted_at IS NULL
  AND c.archived_at IS NULL
  AND (c.publish_start_at IS NULL OR c.publish_start_at <= NOW())
  AND (c.publish_end_at   IS NULL OR c.publish_end_at   >  NOW())
  -- v0.11 — Category 自己也要 live(若有 category filter)
  [AND cat.deleted_at IS NULL AND cat.archived_at IS NULL]
  -- 原 q + filter
  AND (p.name ILIKE '%' || $q || '%' OR p.description ILIKE '%' || $q || '%')
  [AND p.charity_id = $charityId]
ORDER BY p.display_order ASC, p.created_at DESC, p.id DESC          -- v0.11 — 排序加 displayOrder
LIMIT $limit
```

> **Cascading visibility 業務語意**(ADR 006 §3):Charity 的合作合約過期(`publishEndAt < NOW()`)時,旗下所有 Project / SaleItem **自動**從 public list 消失,不需另外改子表;續約只動 Charity 一個欄位,子表全部自動恢復。**禁止**用 batch job 同步狀態。

同樣 `en` locale 改打 `name_en` / `description_en`。Project / SaleItem **無 `content` 搜尋**(content 是長文,v0.7 trgm index 也未涵蓋,spec 015 §4.2)。

子表繼承的成本:多 1 個 JOIN。索引齊全(spec 015 §4.1)下中等資料量無感。
- 搭配 spec 015 §4.2 trigram GIN,中等資料量能用 index scan
- `q` 內含 `%` / `_` 不做 escape — Prisma 參數綁定無注入風險,但 client 需自行理解「`%` 萬用」行為(開放問題,見 §13)
- **不**用 trigram similarity score 排序(資料規模 + Figma 無相關性排序 UI;開放問題,見 §13)

---

## 5. 邊界與錯誤

### 5.1 錯誤碼(沿用 spec 005 RFC 7807)

三 endpoint 共用:

| Status | code | 觸發 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | `q` 超長 / 含禁止字元;`limit` 超出 1~50;`charityId` 非 uuid |
| 400 | `CATEGORY_UNKNOWN` | `category` 通過 schema 長度檢查但**不在 16 個白名單**內(typo / stale URL / 攻擊)— 由 `src/domain/category/keys.ts::parseCategoryKey` 在 route handler 啟動點擋下,**不**進 service。`details` 帶 `{ category, allowed: [...16 keys] }` 方便 client 顯示 |
| 400 | `PAGINATION_CURSOR_INVALID` | cursor 解碼失敗 |
| 404 | `CHARITY_NOT_FOUND` | `GET /v1/donation/charities/:id` |
| 404 | `DONATION_PROJECT_NOT_FOUND` | `GET /v1/donation/donation-projects/:id` |
| 404 | `SALE_ITEM_NOT_FOUND` | `GET /v1/donation/sale-items/:id` |
| 429 | `RATE_LIMITED` | 觸發 §10 限流 |
| 500 | `INTERNAL_ERROR` | DB 失敗等 |

### 5.2 邊界回應

| 情境 | 行為 |
|---|---|
| 完全空表 | 200 + `{ items: [], pageInfo: { nextCursor: null, hasMore: false } }` |
| 搜尋無結果(Figma「No Result」frame)| 同上 200 + 空 list,**不**回 404 |
| `cursor` 指到已刪除 row | 200,從相鄰位置續發(spec 009 §5.4)|
| `q` 為空字串 / 全空白 | trim 後等價於未傳 → 不過濾 |
| `charityId` 指到不存在的 Charity | 200 + 空 list(**不**回 404 — 列表語意是「過濾後沒結果」)|
| `category` 為合法 key 但無 Charity 掛該分類 | 200 + 空 list(列表語意,**非錯誤**)|
| `category` 不在白名單(如 `animals` typo)| 400 `CATEGORY_UNKNOWN`,**不**回 200(用 key 後拼錯就能 fail-fast)|

---

## 6. `GET /v1/donation/categories`(分類字典)

### 6.1 Request

```http
GET /v1/donation/categories HTTP/1.1
Accept: application/json
```

無 query 參數。本端點回傳全部分類(目前固定 16 筆,無分頁需求 — 對齊 brief v0.6 §2.6)。

### 6.2 Response(200 OK)

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Request-Id: <uuid>
Cache-Control: public, max-age=300, must-revalidate, stale-while-revalidate=86400
ETag: "v1:categories:<hash>"

{
  "items": [
    { "id": "1a2b...", "key": "animal",      "displayName": "流浪動物", "displayOrder": 10 },
    { "id": "2b3c...", "key": "environment", "displayName": "環境保護", "displayOrder": 20 },
    { "id": "3c4d...", "key": "education",   "displayName": "弱勢教育", "displayOrder": 30 },
    { "id": "4d5e...", "key": "medical",     "displayName": "醫療關懷", "displayOrder": 40 },
    { "id": "5e6f...", "key": "elderly",     "displayName": "銀髮關懷", "displayOrder": 50 },
    { "id": "6f70...", "key": "disaster",    "displayName": "急難救助", "displayOrder": 60 }
  ]
}
```

### 6.3 回應欄位

| 欄位 | 必有 | 型別 | 說明 |
|---|---|---|---|
| `items[].id` | ✅ | uuid string | 內部 entity identifier(非 filter 用 — filter 走 `key`)|
| `items[].key` | ✅ | string | **filter 用** — list endpoint `?category=<key>` 帶這個值 |
| `items[].displayName` | ✅ | string | UI 顯示文字 |
| `items[].displayOrder` | ✅ | int | dropdown 排序;前端已 ORDER BY 過,直接渲染 |

### 6.4 規則

- **不分頁**(分類數量小,固定 < 50;若超出,改加 `?q=` 搜尋,本 spec v0.5 不處理)
- 預設 `ORDER BY display_order ASC, key ASC`
- 共用 cache:**`Cache-Control: public, max-age=300, must-revalidate, stale-while-revalidate=86400`** + ETag — 與 list endpoint 不同(category 字典變動極少,可中介層 cache 5 分鐘)。**v0.13 — `stale-while-revalidate=86400`(B6)**:max-age 過後 24h 內仍允許 CDN / browser 拿過期內容後背景 revalidate,提升 categories endpoint 韌性(網路抖動 / 短暫 5xx 下使用者仍能拿到 dropdown)。對 admin 改字典的可見性影響:從原本「最多 5 分鐘 stale」延長到「最多 5 分鐘 stale + 背景 revalidate」,實際因 admin endpoint(`whereForAdmin`)立即生效仍可接受。
- 條件 GET(`If-None-Match`)命中回 304
- **v0.8 i18n**:`Accept-Language: en` 時,`displayName` 欄位回 `displayNameEn`(Category 16 筆強制 backfill,所以**不**會 fallback)。ETag 與 cache key **包含 locale**,避免 zh / en 互相污染(具體做法:cache key 加 `Vary: Accept-Language` header)
- **v0.11 lifecycle filter**(backend ADR 006):查詢 `WHERE deleted_at IS NULL AND archived_at IS NULL`(Category 沒有 publishStartAt / publishEndAt — 字典表無合作期限,spec 015 v0.9 §3.3)。**Cache 影響**:Category 字典極少改動,5 分鐘 max-age 仍然合理;admin archive 一個分類後最多 5 分鐘前端會看到舊資料,可接受(admin endpoint 走 `whereForAdmin` 立即看到正確結果)|

---

## 7. 單筆查詢端點(detail)

v0.6 後三個 `GET /v1/donation/{resource}/:id` 的 response shape **比 list item 多更多欄位**(對應詳情頁 IMG_4876 / 4883 / 4882)。詳細 contract 與 schema 由 [spec 017](./017-detail-apis.md) 擁有,本 spec 只列共用規則:

### 7.1 Request

```http
GET /v1/donation/charities/0e1b...c9 HTTP/1.1
GET /v1/donation/donation-projects/0e1b...c9 HTTP/1.1
GET /v1/donation/sale-items/0e1b...c9 HTTP/1.1
```

### 7.2 Response(200 OK)

Shape 詳見 spec 017。重點差異(對 list item 而言):

- **Charity detail**:加 `contactPhone` / `contactEmail` / `officialWebsite` / `approvalNo` / `categories`(M:N inflated)
- **DonationProject detail**:加 `coverImageUrl` / `content`(完整長文)/ `raisingApprovalNo` / `reliefApprovalNo` / `charity`(nested object)/ `categories`
- **SaleItem detail**:加 `coverImageUrl` / `content` / `priceTwd` / `raisingApprovalNo` / `reliefApprovalNo` / `charity` / `categories`

### 7.3 規則

- `:id` 非 uuid 格式 → 400 `VALIDATION_FAILED`
- 不存在 → 404,code 依 entity 對應(§5.1)
- ETag:`"<sha256(id + updatedAt)前 16 字元>"`,搭配 `Cache-Control: private, max-age=0, must-revalidate`(spec 009 §8)
- `If-None-Match` 命中 → 304(spec 009 §3.1)

---

## 8. Headers

沿用 spec 009 §6,三 endpoint 一致:

| Header | 在本端點 | 備註 |
|---|---|---|
| `Content-Type` | 成功 `application/json; charset=utf-8`;錯誤 `application/problem+json` | |
| `X-Request-Id` | 必有 | 對齊 log `reqId`(spec 004 §6.3)|
| `Cache-Control` | 列表 / 單筆都用 `private, max-age=0, must-revalidate` | |
| `ETag` | 列表:**不**回(cursor 多變);單筆:回 | |
| `Content-Language` | 必有 | `zh-TW` 或 `en`,告知 client 實際選用的 locale(可能不同於 `Accept-Language` 請求,例如未支援 fallback 為 zh-TW)|
| `Vary` | 必有 | 含 `Accept-Language` — 確保 CDN / proxy 不會把不同 locale 的回應混用(尤其 `/v1/donation/categories` 是 `public` cacheable)|
| `Location` | 不適用(無 201)| |
| `X-RateLimit-*` | 429 時必有 | spec 010 |

---

## 9. CORS

三 endpoint 皆為 public 讀取,由 spec 012:

- `Access-Control-Allow-Origin`:`FRONTEND_ORIGIN` env 白名單(BFF + 正式 web)
- `Access-Control-Allow-Methods`:`GET, OPTIONS`
- 不允許 `*`

---

## 10. Rate Limit

沿用 spec 010 預設 bucket:

- **public read**:60 req / min / IP
- 三 endpoint **共用同一 bucket key**(同 IP,不分 resource)— 避免 client 用三 endpoint 繞限額
- 觸發 → 429 `RATE_LIMITED` + `Retry-After`

### 10.1 BFF 拓墣下的 rate-limit key(v0.13 — B1)

本 API 對 public 開放但**實際生產環境前面壓一層 Next.js BFF**(frontend route handler,經由內部 service mesh 呼叫 backend)。若直接用 raw `request.ip` 為 bucket key,**整個前端站台共用同一個 IP**,60/min 不到 5 秒就被一個熱門使用者吃光,其餘 user 全 429。

規約:

1. **必信任 proxy**:Fastify `trustProxy` 已開(spec 011 / `tests/integration/trust-proxy.test.ts`),`request.ip` 會取 `X-Forwarded-For` 第一段(真實 client IP),BFF egress IP 不會誤用為 bucket key。
2. **BFF 必須轉發 `X-Forwarded-For`**:Next.js 16 route handler 透過 `headers()` 取得 inbound `x-forwarded-for`,附加 inbound `request.ip` 後送 backend(frontend spec 001e backend-fetch 應同步)。若 BFF 沒轉發,backend 看到的 client IP 一律為 BFF egress IP → bucket 共用問題仍在。
3. **若同時有 session**:rate-limit key 可加 session id(`bucket = ip + sessionId`),不同 user 不互相污染;未登入流量仍走 IP-only。
4. **Demo 環境**:若 demo 需要連續無限滾動三 tab × 3 頁,把 limit 拉到 600/min/IP(env override),不寫死於 spec。

> **未做這層**:backend 看到的會是 frontend 容器 IP,實質「整個 demo 全站共一個 bucket」。請在 frontend route handler PR 同步補 `X-Forwarded-For` 轉發。

---

## 11. Caching

### 11.1 列表

- **不**回 ETag
- `Cache-Control: private, max-age=0, must-revalidate`
- BFF 側可自行 short TTL cache(例 5s)削平 burst
- **v0.11 — lifecycle 時間敏感性**:list query 結果依賴 `NOW()`(`publishStartAt` / `publishEndAt` 視窗)。`private, max-age=0` 確保每次都重新 revalidate,**時間敏感資料不會 stale**。**BFF 短 TTL cache(5s)是上限** — 不要拉超過 30 秒,否則「上下架瞬間」可見性誤差會被使用者感知
- **v0.13 — BFF cache key 必含維度(B4)**:若 BFF 啟用 short TTL cache,cache key **必須**完整覆蓋下列維度,否則 zh / en 互相污染、不同 filter 共用結果、cursor 翻頁拿到舊頁:

  ```ts
  // frontend BFF — route handler 內 short-TTL cache 的 key
  const cacheKey = [
    pathname,              // /v1/donation/charities | /v1/donation/donation-projects | /v1/donation/sale-items
    q ?? '',
    category ?? '',
    cursor ?? '',
    String(limit ?? 10),
    charityId ?? '',       // Project / SaleItem only
    acceptLanguage,        // 'zh-TW' | 'en' — 不可缺
  ].join('|')
  ```

  反例:只用 pathname + q → en 使用者搜 `stray` 拿到上一個 zh-TW 結果。`Vary: Accept-Language`(spec 016 §8)管的是 CDN / browser cache,**BFF 自管的 in-memory cache 不會自動套用 Vary**,必須自己列。

### 11.2 單筆

- 回 ETag(§6.3),客戶端可條件 GET 取 304
- **v0.11 — lifecycle 一致性**:detail endpoint 同樣 `private, max-age=0, must-revalidate`(spec 017 §2 定錨);archived / deleted / 排程未到 / 排程已過 row → 404(不洩漏存在),ETag 對這些 row **不**簽發

### 11.3 Idempotency

- 三 endpoint 只讀,**不**接受 `Idempotency-Key`(spec 009 §7.1);若 client 送了,server 忽略

---

## 12. 實作層共用抽象

三 list endpoint 的 query / response schema、route handler、service 查詢、cursor encode / decode **高度重疊**(差別僅在 Project / SaleItem 多一個 `charityId` query 參數與 response 欄位)。實作層用 base schema + intersection 收斂;`/v1/donation/categories` 自成一套(無分頁)。

```ts
// src/schemas/donation-item/shared.ts
export const ListQueryBase = Type.Object({
  q:        Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  category: Type.Optional(Type.Union(CATEGORY_KEYS.map(k => Type.Literal(k)))),
  // ↑ CATEGORY_KEYS 來自 src/domain/category/keys.ts(spec 015 §7.2),16 個 literal union
  cursor:   Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  // v0.13 — maxLength 對齊實作(原 spec 寫 512,實作用 1024;cursor payload 是 base64url 三段,1024 留餘裕)
  limit:    Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
  // v0.12 已移除 `sort` 參數(§4.5 凍結排序為 display_order ASC, created_at DESC, id DESC)
})

// Project / SaleItem 多 charityId 過濾(實作名稱:`ListQueryWithCharityId`)
export const ListQueryWithCharityId = Type.Intersect([
  ListQueryBase,
  Type.Object({
    charityId: Type.Optional(Type.String({ pattern: UUID_V4_PATTERN })),
    // v0.13 — 用顯式 UUID v4 pattern,Fastify Ajv 不依賴 `format: 'uuid'` ajv-formats 額外註冊
  }),
])

// v0.13 — 統一 null 語意:logoUrl / coverImageUrl 為 `string | null`,key 永遠存在
// (spec 009 §4.4 v0.2)
const InflatedCategory = Type.Object({
  id:          Type.String(),
  key:         Type.String(),
  displayName: Type.String(),
})

export const ItemBase = Type.Object({
  id:          Type.String(),
  name:        Type.String(),
  description: Type.String(),
  logoUrl:     Type.Union([Type.String(), Type.Null()]),
  categories:  Type.Array(InflatedCategory),   // v0.13 — Charity 也帶 categories
  createdAt:   Type.String(),
  updatedAt:   Type.String(),
})

// Charity list item = ItemBase
export const CharityListItem = ItemBase

// v0.6 / v0.13:Project list item — parent FK + cover + 繼承 categories
export const ProjectListItem = Type.Object({
  id:            Type.String(),
  charityId:     Type.String(),
  charityName:   Type.String(),
  name:          Type.String(),
  description:   Type.String(),
  logoUrl:       Type.Union([Type.String(), Type.Null()]),
  coverImageUrl: Type.Union([Type.String(), Type.Null()]),
  categories:    Type.Array(InflatedCategory),  // 繼承自主辦團體
  createdAt:     Type.String(),
  updatedAt:     Type.String(),
})

// v0.6:SaleItem list item 同 Project + priceTwd
export const SaleItemListItem = Type.Object({
  id:            Type.String(),
  charityId:     Type.String(),
  charityName:   Type.String(),
  name:          Type.String(),
  description:   Type.String(),
  logoUrl:       Type.Union([Type.String(), Type.Null()]),
  coverImageUrl: Type.Union([Type.String(), Type.Null()]),
  priceTwd:      Type.Integer({ minimum: 0 }),
  categories:    Type.Array(InflatedCategory),
  createdAt:     Type.String(),
  updatedAt:     Type.String(),
})

export const PageInfo = Type.Object({
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  hasMore:    Type.Boolean(),
})

export const makeListResponse = (item: TSchema) =>
  Type.Object({ items: Type.Array(item), pageInfo: PageInfo })

// src/schemas/category/shared.ts
export const CategoryItem = Type.Object({
  id:           Type.String({ format: 'uuid' }),
  key:          Type.String(),
  displayName:  Type.String(),
  displayOrder: Type.Integer(),
})

export const CategoryListResponse = Type.Object({
  items: Type.Array(CategoryItem),
})
```

三 endpoint 各自組裝:

```ts
// src/routes/v1/donation/charities/index.ts
fastify.get('/v1/donation/charities', {
  schema: {
    querystring: ListQueryBase,
    response: { 200: makeListResponse(CharityListItem) },
  },
}, async (req) => charityService.list(req.query))

// src/routes/v1/donation/donation-projects/index.ts
fastify.get('/v1/donation/donation-projects', {
  schema: {
    querystring: ListQueryWithCharityId,
    response: { 200: makeListResponse(ProjectListItem) },
  },
}, async (req) => donationProjectService.list(req.query))

// src/routes/v1/donation/sale-items/index.ts(item schema 多 priceTwd)
fastify.get('/v1/donation/sale-items', {
  schema: {
    querystring: ListQueryWithCharityId,
    response: { 200: makeListResponse(SaleItemListItem) },
  },
}, async (req) => saleItemService.list(req.query))

// src/routes/v1/donation/categories/list.ts
fastify.get('/v1/donation/categories', {
  schema: { response: { 200: CategoryListResponse } },
}, async () => categoryService.list())
```

Service 層亦類似:

```ts
// 一個 generic 函式吃 Prisma delegate + 共同篩選條件,
// 三個 service 各 wrap 一次,差別僅 Prisma client 入口。
function buildListService<T>(delegate: PrismaDelegate<T>) { ... }
```

> 此 §11 是實作 hint,不是強制 contract;實作 PR 可微調。

---

## 12.1 OpenAPI 文件(v0.13 — B5)

Fastify route schema 已是 JSON-Schema 起點,**dev 環境**自動產出 OpenAPI 屬零成本附加(spec 009 §1.3 原列 out of scope,本 spec 把產出路徑收進來,但仍**不**強制 prod 暴露)。

規約:

- 套件:`@fastify/swagger` + `@fastify/swagger-ui`(已在 `package.json` 預留 — 待 PR 接上)
- 暴露條件:`NODE_ENV !== 'production'` 才註冊;prod 環境 `/openapi.json` / `/docs` 一律 404(避免無意間洩漏內部 schema 給攻擊者掃)
- 路徑:`GET /openapi.json` 回 JSON、`GET /docs` 回 Swagger UI
- 來源:Fastify route schema **直接餵入**,本 spec §12 的 TypeBox 物件全部會自動進文件,無需手寫 YAML
- security scheme:本 spec 三個 list endpoint 為 public,文件不必標 Bearer;若日後加 admin endpoint,在該 route 加 `tags: ['admin']` + `security: [{ bearerAuth: [] }]`
- CORS:OpenAPI endpoint 不對外暴露,不必加白名單

> 評審意義:7 天作業 demo 時開 `/docs` 直接看 spec 化的 contract,比手寫 README 列舉端點更有說服力;同時驗證「schema-driven 是真的,不是名義上」。

---

## 13. 測試矩陣

共同案例對三 endpoint 都跑(可寫成 `describe.each`);`*` 標示「對 Project / SaleItem 額外執行」。

| 層 | 案例 | 期望 |
|---|---|---|
| unit | Cursor encode / decode 來回一致 | 對 |
| unit | `parseCategoryKey('animals')` 回 400 `CATEGORY_UNKNOWN`,`details.allowed` 帶 16 keys;`parseCategoryKey(undefined)` 回 `undefined`(filter 略過);`parseCategoryKey('animal_protection')` narrow 成 `CategoryKey` 型別 | 對 |
| integration | seed 30 筆後,預設 `limit`(10)取 3 頁能拿到全部、`hasMore` 在最後一頁為 `false`、`nextCursor` 為 `null` | 對 |
| integration | `q=流浪動物` 命中至少 1 筆且**全部**結果包含關鍵字 | 對 |
| integration | `q=zxq` 無結果回 200 + 空 list(對應 Figma No Result frame) | 對 |
| integration | **Charity tab** `category=animal_protection` + `q=流浪動物` 同時生效;結果中所有 Charity 都掛 animal_protection Category | 對 |
| integration `*` | **Project / SaleItem tab(子表繼承)**:`category=animal_protection` 結果中所有 item 的 `charityId` 對應的 Charity 都掛 animal_protection | 對 |
| integration | `category=animals`(拼錯,不在白名單)→ 400 `CATEGORY_UNKNOWN`(**不**回 200)| 對 |
| integration | `category=animal_protection` 但 seed 中**無**任何 charity 掛該分類 → 200 + 空 list(列表語意)| 對 |
| integration `*` | `charityId=<uuid>` 過濾結果只含該團體的子資料 | 對 |
| integration `*` | `charityId=<unknown-uuid>` 回 200 + 空 list,**不**回 404 | 對 |
| integration `*` | `q=...` + `charityId=...` + `category=...` 三條件同時生效 | 對 |
| integration | `GET /v1/donation/{resource}/<invalid-uuid>` | 400 |
| integration | `GET /v1/donation/{resource}/<unknown-uuid>` | 404 對應 code |
| integration | 條件 GET `If-None-Match` 命中 | 304 |
| integration | **`GET /v1/donation/categories`** 回 16 筆,按 `displayOrder ASC` 排序;有 `ETag`;`If-None-Match` 命中回 304 | 對 |
| integration | **v0.8 i18n locale 切換**:`Accept-Language: en` → response `name` 內容為英文(若有翻譯)或中文 fallback;`Content-Language: en` 必有 | 對 |
| integration | **v0.8 i18n 搜尋**:`Accept-Language: en` + `q=stray` 命中 `nameEn` 含 stray 的列;同 query 在 `zh-TW` 不命中(因英文欄位 trgm index 不參與中文搜尋)| 對 |
| integration | **v0.8 i18n fallback**:`Accept-Language: en` 拿到的某筆 charity `nameEn` 為 NULL → response `name` 為原中文(verify 不出現 `null` 或空字串)| 對 |
| integration | **v0.8 i18n unsupported locale**:`Accept-Language: ja` → 200,`Content-Language: zh-TW`(fallback),不回 400 | 對 |
| integration | **v0.8 Vary header**:三 list endpoint + categories endpoint 的 response 都有 `Vary: Accept-Language` | 對 |
| e2e | 三 tab 各自:無限滾動 3 頁 + 1 次搜尋 + 1 次清空,共 9 個情境跑完 | 全綠 |
| e2e | tab 切換時 client 改打不同 endpoint(BFF route handler 切換)| 對 |
| e2e | 進頁面先打 `/v1/donation/categories` 取 dropdown 內容 → 選一個 → 三 tab filter 都跑得通 | 全綠 |
| integration | **v0.11 排序變更**:list 三 endpoint 預設排序為 `display_order ASC, created_at DESC, id DESC`;seed 兩筆 displayOrder = -1 / -2 + 一筆 displayOrder = 0,前兩筆出現在 page 1 最前 | 對 |
| integration | **v0.11 cursor 三段相容**:首頁拿到 `nextCursor`,decode 後含 `lastDisplayOrder` / `lastCreatedAt` / `lastId` 三欄;帶它打第二頁不重複也不漏 row | 對 |
| integration | **v0.11 cursor pointing at soft-deleted row**:首頁 nextCursor 取到後,把該 `lastId` 對應 row set `deletedAt = NOW()`,帶 cursor 打下一頁仍然 200 + 從相鄰位置續發(spec 009 §5.4)| 對 |
| integration | **v0.11 lifecycle filter — archived**:seed `archivedAt = past` 的 row 不出現在三 list endpoint 的結果 | 對 |
| integration | **v0.11 lifecycle filter — deleted**:seed `deletedAt = past` 的 row 同樣不出現 | 對 |
| integration | **v0.11 lifecycle filter — publishStartAt 未到**:seed `publishStartAt = future` 的 row 當下不出現;**fake clock 推到 publishStartAt + 1s** 後出現 | 對 |
| integration | **v0.11 lifecycle filter — publishEndAt 已過**:seed `publishEndAt = past` 的 row 不出現 | 對 |
| integration `*` | **v0.11 Cascading visibility(ADR 006 §3)**:setup Charity A `publishEndAt = past`(合約過期),旗下 Project P1 / SaleItem S1 自身 lifecycle 全空(預設「永久上架」);`GET /v1/donation/donation-projects` 不包含 P1;`GET /v1/donation/sale-items` 不包含 S1;`GET /v1/donation/charities` 也不包含 A | 對 |
| integration `*` | **v0.11 Cascading visibility — 反向恢復**:接續上一條 — 把 A.publishEndAt 設回未來,三 endpoint 同次 query 全部重新看到(無 cache 干擾)| 對 |
| integration `*` | **v0.11 Cascading visibility — archived parent**:Charity B `archivedAt = past`,旗下 Project / SaleItem 自身全空 — public list 同樣不包含子表 | 對 |
| integration | **v0.11 `/v1/donation/categories` lifecycle**:seed Category `archivedAt = past`,dropdown response 不包含;seed `deletedAt = past` 的 Category 同樣不包含 | 對 |

---

## 14. 開放問題

- **Trigram similarity 排序**:要不要用 `similarity(name, q) DESC` 取代 `createdAt`?目前否,但 demo 時若評審質疑「為什麼結果順序不貼近關鍵字」,可快速切換(僅改 service 層,API contract 不變)
- **`%` / `_` escape**:`q` 內含 SQL LIKE 萬用字元時,目前直接帶入。是否要 escape 為字面?待產品確認;若要,改 service 層,API contract 不變
- **中文分詞**:`pg_trgm` 對中文是 character-level trigram。要詞素級需 `zhparser` + `tsvector`,部署成本高(spec 015 §4.3)。本 spec 不處理
- **三 tab 是否共用一組 category 白名單**:目前共用(spec 015 §7.2);若拆,本 spec query schema 要 per-endpoint 收斂
- **多語言**:同 spec 015 §12 — 改 response schema 為 `name: { 'zh-TW': '...' }` 屬 breaking change,需 `/v2`
- **`?include=categories` 嵌入 Charity 的 categories**:目前列表 item 不含 categories;若 UI 要顯示「該團體屬於哪些分類」,加 include 屬 additive
- **`?category=key1,key2` 多選**:目前 UI 單選 = API 單選;未來改多選只需把 query 改為 comma-separated keys,Schema 與 contract 都不破壞(屬 additive)
- **分類動態化(admin CRUD 任意 key)**:目前 16 個 key 為 application-level enum(寫死於 `CATEGORY_KEYS` union);若日後改後台允許任意 key,則 `Type.Union` 需放鬆為 `Type.String`,改靠 DB 查詢驗證 — **此情境出現時改回 `?categoryId=<uuid>` 較安全**(避免 free-form key 造成 SQL injection 攻擊面),屬升級觸發,見 backend ADR 002 §升級觸發
- **`X-Total-Count`**:spec 009 §5.4 明確不提供;若評審 demo 想看「共 N 筆」,另開 `GET /v1/donation/{resource}/count` 子端點
- **embedded charity in Project / SaleItem response**:目前只回 `charityId`,前端要顯示團體名稱需另呼叫 `/v1/donation/charities/:id`。若要避免 N+1,日後可加 `?include=charity` 把 charity 物件嵌入 item(屬於 additive 變更,不破壞 contract)
- **巢狀 URI**(`/v1/donation/charities/:id/donation-projects` vs `?charityId=`):目前採 flat + query param,語意清楚且支援 cross-charity 列表;若評審期待 RESTful 巢狀,可額外暴露 `/v1/donation/charities/:id/donation-projects` 作為 alias(同樣 service,僅 routing 不同),不影響既有 contract
- **Charity GET 包含子表 count**:目前 `GET /v1/donation/charities/:id` 不含 `donationProjectsCount` / `saleItemsCount`;若 UI 需要,加 `?include=counts`(對應 spec 015 §12 開放問題)

---

## 15. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-13 | 初版,僅 `GET /v1/donation/charities` 列表 / 搜尋 / cursor 分頁(對應 brief v0.1) |
| 0.2 | 2026-06-14 | 範圍擴大至三 endpoint。新增 `GET /v1/donation/donation-projects` / `GET /v1/donation/sale-items`,query / response shape 共用,Project / SaleItem item 多 `charityId` 欄位;新增 §11 共用抽象示意。對齊 brief v0.2 與 spec 015 v0.2 |
| 0.3 | 2026-06-14 | 移除 `charityId` query 參數、response 欄位、相關 test。三 endpoint shape **完全一致**(無 entity-specific 差異),§11 schema 合一,§12 測試改為 parametrized。`limit` 預設 20 → 10(對齊 brief v0.3 無限滾動)。對齊 spec 015 v0.3 |
| 0.4 | 2026-06-14 | 回復 `charityId` query 參數(Project / SaleItem)、response 欄位、相關 test。§11 schema 用 `Intersect` 模式重新分層(`ListQueryBase` / `ListQueryWithCharityFk`)。新增「巢狀 URI」與「Charity GET include counts」開放問題。`limit` 預設 10 保留。對齊 spec 015 v0.4 |
| 0.5 | 2026-06-14 | 引入分類 M:N(backend ADR 002):`?category=<key>` enum → `?categoryId=<uuid>` 並改走 JOIN `charity_categories`;Project / SaleItem 透過主表繼承(子表 filter 多 1 層 JOIN);新增 `GET /v1/donation/categories` 端點(無分頁、5 分鐘 cache);移除 item response 的 `category` 欄位;§12 schema 移除 `CATEGORY_KEYS` enum、`categoryId` 改 uuid;§13 補子表繼承 filter 測試與 `/v1/donation/categories` 測試。對齊 spec 015 v0.5 |
| 0.6 | 2026-06-14 | 截圖補件(IMG_4875-4883)欄位 / response 擴充:(1) §4.3 / §4.4 三 endpoint list response 對應卡片 layout 拆分 — Charity 不變,Project 加 `charityName`/`coverImageUrl`/`categories`,SaleItem 同 + `priceTwd`;(2) §7 detail endpoint shape 移至 [spec 017](./017-detail-apis.md);(3) §12 schema `DonationProjectListItem` / `SaleItemListItem` 重新分層。對齊 spec 015 v0.6 |
| 0.7 | 2026-06-14 | 所有 endpoint 加 `/donation/` 前綴(產品需求 — feature namespace):`/v1/charities` → `/v1/donation/charities`、`/v1/donation-projects` → `/v1/donation/donation-projects`、`/v1/sale-items` → `/v1/donation/sale-items`、`/v1/categories` → `/v1/donation/categories`。資源名稱保持不變(避免 breaking change 過大);`donation/donation-projects` 名稱重複為刻意取捨。同步更新 spec 017、ADR 001/002、frontend specs 002/004 系列 |
| 0.8 | 2026-06-14 | 引入 i18n(backend ADR 004):(1) §2 設計原則 6 新增 `Accept-Language` 機制;(2) §4.1 / §4.1.1 加 request header 與 locale 解析語意(`zh-TW` 預設、`en` 支援、其他 fallback、quality value 規則);(3) §4.6 SQL 範例補「locale 切換 name / name_en」;(4) §6 `/v1/donation/categories` 補 `displayNameEn` 處理 + `Vary: Accept-Language` cache key;(5) §8 Headers 加 `Content-Language` / `Vary` 為必有;(6) §12 schema(TypeBox)不變(response shape 對 client 不變);(7) §13 補 6 條 i18n 整合測試 |
| 0.9 | 2026-06-14 | **議題 A 收尾**:filter 參數 `?categoryId=<uuid>` → `?category=<key>`(對齊 brief v0.6 URL sync;backend ADR 002 v0.2)。(1) §4.2 query param 改 `category: CategoryKey`(16 literal union);(2) §4.6 SQL JOIN `categories.key`(unique index);(3) §5.1 新增 `CATEGORY_UNKNOWN` 400 — wildcard typo 直接 reject;(4) §5.2 邊界拆「合法 key 無命中 → 200」與「拼錯 → 400」;(5) §6.3 categories response 標註 `key` 為 filter 用值;(6) §12 schema 用 `Type.Union(literals)` 替換 uuid format;(7) §13 補白名單檢查、拼錯、無命中、子表繼承四條 test;(8) §14 補多選 / 動態化升級觸發 |
| 0.10 | 2026-06-14 | 圖片改 server 端拼 URL(spec 018 v0.2 / spec 015 v0.8):DB 存 `logoKey` / `coverImageKey`,response 仍維持 `logoUrl` / `coverImageUrl`(完整 URL,由 `objectUrl(key)` 拼)。**response shape 對 client 不變**,僅 service 層多一次 URL builder 呼叫。§2 新增設計原則 7。換 CDN / bucket = 改 env,不必 backfill DB |
| 0.11 | 2026-06-14 | Entity lifecycle + cascading visibility 落實到 list query(**backend ADR 006 / spec 015 v0.9**):(1) §2 設計原則 8 — 所有公開 list 必須走 `whereLive(now)` helper,Project / SaleItem cascade parent Charity 的 `whereLive`(`whereLiveWithParent`);(2) §4.5 預設排序改 `display_order ASC, created_at DESC, id DESC`,cursor payload 改三段(`lastDisplayOrder` / `lastCreatedAt` / `lastId`);(3) §4.6 三段 SQL 範例補 `whereLive` 四條件,Project / SaleItem SQL 加 JOIN charities + parent whereLive,Category JOIN 也加 `cat.deleted_at IS NULL AND cat.archived_at IS NULL`;(4) cursor 內 `lastId` row 被 soft delete → 不回錯;display_order 被 admin 改動 → 順序可能稍跳,可接受。下游 spec 017 v0.5 同步 |
| 0.12 | 2026-06-14 | 文件對齊修正(無 contract 改動):(1) §4.2 移除 `sort` 參數 — v0.11 §4.5 已凍結排序為 `display_order ASC, created_at DESC, id DESC`(ADR 006 §4 強制),Query 參數表與 §4.5 規則對齊;(2) §5.1 / §7 `VALIDATION_ERROR` → `VALIDATION_FAILED`(spec 005 §4.2 字典為 code 命名權威,本 spec 過去版本拼成 `_ERROR` 是 drift);(3) §5.1 `INTERNAL` → `INTERNAL_ERROR`(同 spec 005);(4) 程式碼端同時把 `PAGINATION_CURSOR_INVALID` / `UNIQUE_CONSTRAINT` / `FK_CONSTRAINT` 三個原本以 string literal 拋出的 code 註冊進 `src/lib/errors/codes.ts`(spec 005 §4.4 governance) |
| 0.13 | 2026-06-14 | 與實作對齊 + best practice 補強:**(A 類 drift)** (1) §4.4 / §6.3 改為「nullable 欄位回 `null`,key 永遠存在」(對齊 spec 009 §4.4 v0.2 與既有 `Type.Union([X, Null])` schema);(2) §4.4 Charity list-item 加 `categories`(對齊 `src/schemas/donation-item/list-item.ts` 既有實作,resolves 原 §4.4 註記);(3) §6.3 移除刪除線殘行 `~~items[].key~~`;(4) §12 `cursor.maxLength` 512 → 1024(對齊 code);(5) §12 範例 `ListQueryWithCharityFk` → `ListQueryWithCharityId`、`charityId` 用 pattern UUID v4 而非 `format: 'uuid'`(對齊 code);(6) §12 範例 `ItemBase` / `ProjectListItem` / `SaleItemListItem` schema 用 `Type.Union([Type.String(), Type.Null()])`,移除過時 `sort` 殘留與 `CategoryKeyEnum`(改用 `InflatedCategory` `{ id, key, displayName }`)。**(B 類 best practice)** (7) §4.2 `q` 加 NFC 正規化(B2),避免不同輸入法 / 平台組合字漏命中;(8) §10.1 BFF 拓墣下的 rate-limit key 規約(B1) — 信任 proxy、轉發 `X-Forwarded-For`、有 session 加 sessionId、demo 加限額;(9) §11.1 BFF cache key 維度規約(B4) — 必含 pathname + q + category + cursor + limit + charityId + Accept-Language;(10) §6.4 categories cache 加 `stale-while-revalidate=86400`(B6);(11) §12.1 新增 OpenAPI 產出規約(B5) — dev `/openapi.json` + `/docs`,prod 404。下游 spec 017 v0.6 同步 |
| 0.14 | 2026-06-14 | `CATEGORY_UNKNOWN` 落實:(1) §5.1 註腳更新 — 不再用 TypeBox `Type.Union(literals)`(那會回 `VALIDATION_FAILED`),改在 route handler 啟動點呼叫 `src/domain/category/keys.ts::parseCategoryKey()`,把白名單檢查從 schema 層下放到 domain 層;`details` 帶 `{ category, allowed: [...16 keys] }` 方便 client 列示;(2) §13 unit test 描述同步;(3) `src/lib/errors/codes.ts` 註冊 `CATEGORY_UNKNOWN` → 400(spec 005 §4.4 governance);(4) `src/schemas/donation-item/shared.ts` `category` 從 `Type.Union(literals)` 鬆綁為 `Type.String({ minLength: 1, maxLength: 40 })`,保留長度檢查(對齊 spec 015 §3.3 VARCHAR(40));(5) 3 個 list route handler 呼叫 `parseCategoryKey(req.query.category)` 後再傳進 service。**邊界**:`?category=`(空字串)維持 `VALIDATION_FAILED`(被 schema minLength 擋掉);`?category=animals` 才是 `CATEGORY_UNKNOWN`(過 schema 但不在白名單)|
| 0.15 | 2026-06-16 | §1 加 spec 023 §2 URL prefix cross-ref(public read → `/user/v{N}`、admin write → `/cms`、auth → `/auth`);本 spec endpoint path 列為 surface 內相對路徑,實際 client URL 由 surface prefix 拼成。完整 URL mapping 表見 spec 023 §2.4。對應 backend code/test 已 cutover 至新結構 |
