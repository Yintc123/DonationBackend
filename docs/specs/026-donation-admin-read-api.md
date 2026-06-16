# Spec 026: Donation Admin Read API

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft(v0.1) |
| 建立日期 | 2026-06-16 |
| 路徑(規劃) | `src/routes/cms/donation/charities.ts`(已存,加 GET handler)<br>`src/routes/cms/donation/donation-projects.ts`(已存,加 GET handler)<br>`src/routes/cms/donation/sale-items.ts`(已存,加 GET handler)<br>`src/domain/donation-item/admin-read-services.ts`(新,whereForAdmin 查 + admin shape mapping)<br>`src/schemas/donation-item/admin-detail.ts`(新)<br>`src/schemas/donation-item/admin-list-item.ts`(新)<br>`src/domain/lifecycle/where-for-admin.ts`(新,實作 spec 015 §3.3 v0.9 已 spec 但未實作的 helper) |
| 相關 spec | `015-charity-data-model.md`(lifecycle 欄位、`whereForAdmin` 設計約定)、`016-charity-list-api.md`(user-side list)、`017-detail-apis.md`(user-side detail)、`019-cache-policy.md`(admin endpoint 不快取的根據)、`020-donation-write-api.md`(同 `/cms` 路徑、共享 auth gate 與 rate limit pattern)、`023-api-routing-versioning.md`(`/cms/*` 不版本化的決策)、`024-cud-surface-invariant.md`(`/cms` 為唯一 admin 介面;讀也算 admin operation) |

---

## 1. 目的與範圍

### 1.1 目的

將 donation 三主 entity(Charity / DonationProject / SaleItem)的**管理員讀取**端點補齊,使 admin UI([FE spec 011](../../../frontend/docs/specs/011-cms-resource-admin.md))可以:

1. **列出全部 row** — 含 archived / deleted / 未上架(`publishStartAt` 在未來)/ 已下架(`publishEndAt` 在過去),不受 `whereLive` 過濾
2. **取單筆 admin detail** — 即使 archived/deleted 也能編輯;response 含 admin-only 欄位(`displayOrder`、`publishStartAt`、`publishEndAt`、`archivedAt`、`deletedAt`)
3. **過濾旗標** — `?includeArchived=true` / `?includeDeleted=true` 控制是否顯示生命週期已結束的 row

對齊 [020 §1.1](./020-donation-write-api.md#1-目的與範圍) 既有 admin **寫入**端點;本 spec 補上對應的**讀取**面。

### 1.2 In scope

- **6 個讀取端點**(2 個 list + 2 個 detail × ? 不,3 entity × 2)= 6 個:
  - `GET /cms/donation/charities`、`GET /cms/donation/charities/:id`
  - `GET /cms/donation/donation-projects`、`GET /cms/donation/donation-projects/:id`
  - `GET /cms/donation/sale-items`、`GET /cms/donation/sale-items/:id`
- **`whereForAdmin` helper** 實作(spec 015 §3.3 v0.9 已約定但未落地)
- **AdminCharityDetail / AdminProjectDetail / AdminSaleItemDetail TypeBox schema**(public 三 shape 的 superset,加 5 個 admin lifecycle 欄位)
- **AdminCharityListItem / AdminProjectListItem / AdminSaleItemListItem TypeBox schema**(對應 list 端點 row 形狀)
- Query 參數:`limit` / `cursor` / `q` / `category` / `charityId`(對齊 016 §3.2;Charity list 沒有 `charityId`)+ admin 專有 `includeArchived` / `includeDeleted`
- 對齊 [020 §11](./020-donation-write-api.md) 雙層 rate limit(per-user + per-IP);使用「read」level(比 write 寬鬆,參見 §7.2)
- Auth:沿用 [020 §2.3](./020-donation-write-api.md#23-authjwt-role-0--adminv02) `/cms` scope 已就緒的 `requireAdmin` preHandler;讀取端點**也走** admin gate(自然繼承 scope)

### 1.3 Out of scope

- **不**做 admin Category list/detail 端點 — Category 是字典,公開端點 `GET /user/v1/donation/categories` 已可看到所有 live category;archived/deleted category 的編輯入口走 [020 §5.4](./020-donation-write-api.md) write endpoint 直接 hit by id(admin 知道 id 就行)
- **不**做 audit log 查詢端點(誰改了什麼)— spec 020 §14 OQ #4 列入未來
- **不**做 lifecycle history(同一 row 的 archive/restore 軌跡)— 沒有歷史表;只看當前狀態
- **不**做 bulk read(一次 detail 多筆)— admin UI v0.1 不需要
- **不**做 ETag conditional read(`If-None-Match`)— admin endpoint 量少、即時 lifecycle 變動,302 cache-revalidation 收益小
- **不**做圖檔 admin 端點(例 list orphan logos)— 走 S3 lifecycle policy + spec 015 v0.10 cleanup script

---

## 2. 架構評估

### 2.1 為什麼不擴 spec 016 / 017(public read)

| 走 user `/user/v{N}/...` + admin flag | 採用獨立 `/cms/...` 路徑 ✅ |
|---|---|
| 同一 endpoint 兩種行為(user / admin)→ 程式碼分支多 | endpoint 對應一種行為,query/response shape 明確 |
| Cache key 設計變複雜:admin 不該命中 user cache,反之亦然 | admin 端 **不** 用 Redis cache(§8);user 端不受影響 |
| Auth 滲透到 user-side route handler(每條 route 重複判 role) | admin 集中在 `/cms` scope 的 `requireAdmin` preHandler |
| OpenAPI / spec 文件混淆讀者(同 path 不同 owner) | spec 016 / 017 純 public read,本 spec 純 admin read |
| 對齊 [024 invariant](./024-cud-surface-invariant.md) 「entity CUD 一律走 `/cms`」精神不一致(read 也屬於資料管理) | 對齊 |

→ 走 `/cms/...` 與 [020 admin write](./020-donation-write-api.md) 同 prefix,讀寫齊一。

### 2.2 為什麼不擴 spec 020

[020](./020-donation-write-api.md) 主題是 **write** + lifecycle action(POST/PATCH/DELETE)。本 spec 是 **read**(GET),語意完全不同;雖共用 path prefix、auth gate、rate-limit family,但 endpoint 行為(idempotent / 無 side effect / 無 cache invalidation)迥異。獨立 spec 利後續維護(如 read 加 `If-None-Match` 時不污染 020 changelog)。

### 2.3 為什麼 admin 看到的 row 集合 = `whereForAdmin`(全集)

[015 §3.3 v0.9](./015-charity-data-model.md#33-約束共同) 已約定:public 路徑強制 `whereLive`,admin 路徑「必須繞過預設 `whereLive` 走 `whereForAdmin`」。本 spec 為 `whereForAdmin` 的**唯一消費者**(write 端點走 byId,不涉及 list filter)。設計:

```ts
// src/domain/lifecycle/where-for-admin.ts(新)
import type { Prisma } from '@prisma/client'

export type AdminLifecycleFilter = {
  includeArchived: boolean
  includeDeleted: boolean
}

/**
 * Spec 026 §2.3 — admin list 路徑用。預設 admin 看不到 archived / deleted
 * (跟 public 一樣只看「進行中」),但加旗標可一鍵打開查看 lifecycle-已結束
 * 的 row。**不** filter publishStartAt / publishEndAt:admin 必須能編輯未來
 * 上架、已下架的 row,publish window 是 schedule 機制而非生命週期狀態。
 */
export function whereForAdmin(opts: AdminLifecycleFilter): Prisma.CharityWhereInput {
  const where: Prisma.CharityWhereInput = {}
  if (!opts.includeArchived) where.archivedAt = null
  if (!opts.includeDeleted) where.deletedAt = null
  return where
}
```

- **預設(不傳旗標)**:`archivedAt IS NULL AND deletedAt IS NULL`,等同「進行中的 row 全集」(無視 publish window)
- **`includeArchived=true`**:archived row 也出
- **`includeDeleted=true`**:soft-deleted row 也出
- **兩旗標同開**:全表
- 對 Project / SaleItem,**不** cascade parent 的 lifecycle 狀態(spec 015 v0.9 cascading visibility 只適用 public read);admin 看 archived charity 下的 active project 是合理需求

> Public path `whereLive` 強制 4 條件(archived / deleted / publishStart / publishEnd);admin path 預設 2 條件(archived / deleted),旗標可進一步開放。差異承擔在 [whereForAdmin](./015-charity-data-model.md#33-約束共同) helper 內,handler 端不自拼 where。

### 2.4 為什麼 admin endpoint 不快取

對齊 [019 cache policy](./019-cache-policy.md) 的「快取觸發條件」對比:

| 維度 | Public read | Admin read |
|---|---|---|
| QPS 預期 | 高(C-end 流量) | 極低(admin UI 操作) |
| 資料變動容忍 | 60s TTL 可接受(spec 019 §4.1) | 0s(admin 改完立刻要看到 lifecycle 旗標) |
| 個資 / 敏感性 | 公開 | 含 admin metadata(displayOrder / publish 排程) |
| 多語混合 cache 風險 | 已用 locale 切 key | 同 — 但 admin 通常單一語系操作 |

→ admin 端點 `Cache-Control: no-store, private`,直接 hit DB。實作上即:**不**走 `getCachedCharityById`、直接呼 domain 層 `getAdminCharityById`。spec 019 §X 補 cache policy table:`/cms/*` GET = no-store no Redis。

### 2.5 為什麼 admin list 仍用 cursor pagination(對齊 spec 016)

雖然 admin 量小、offset pagination(`?page=2`)在 admin UI 慣例上常見,**仍用 cursor**:

- 對齊 [016 §3.2](./016-charity-list-api.md) 既有 list 套路(`listCharities` 服務、cursor schema、cursor signature `id_DESC_createdAt_DESC`)
- admin UI v0.1 設計上一頁顯示全部(limit=100),不分頁 — cursor 規格保留是給未來大量資料時的擴充
- 統一 list helper(`listCharities` / `listDonationProjects` / `listSaleItems`)只差在 `where` 條件(`whereLive` vs `whereForAdmin`),其他**全相同**,minimal diff

### 2.6 為什麼 admin endpoint 仍尊重 `Accept-Language`

i18n 在 spec 015 §7 / spec 016 設計就強制全 endpoint 一致行為。Admin 也可能用英文介面(尤其招國外人員時)。但實際上 admin 多半 zh-TW;規格上**接受 `accept-language`、傳給 service 層 `pickLocalised`**,行為 1:1 對齊 user-side。

---

## 3. 端點清單

| Method | Path | 用途 | spec 章節 |
|---|---|---|---|
| GET | `/cms/donation/charities` | admin charity list(含 archived/deleted 旗標控制) | §5.1.1 |
| GET | `/cms/donation/charities/:id` | admin charity detail(無視 lifecycle,by id) | §5.1.2 |
| GET | `/cms/donation/donation-projects` | admin project list | §5.2.1 |
| GET | `/cms/donation/donation-projects/:id` | admin project detail | §5.2.2 |
| GET | `/cms/donation/sale-items` | admin sale-item list | §5.3.1 |
| GET | `/cms/donation/sale-items/:id` | admin sale-item detail | §5.3.2 |

對應既有寫入端點([020 §3](./020-donation-write-api.md)):**6 條 read + 23 條 write = 29 個 `/cms/donation/*` admin endpoint**(讀寫合計)。

---

## 4. 共通慣例

### 4.1 Auth

沿用 [020 §2.3](./020-donation-write-api.md#23-authjwt-role-0--adminv02)。`/cms` scope 的 `requireAdmin` preHandler 已就緒,本 spec 加的 GET handler 自然繼承:

- 無 JWT → 401 `UNAUTHENTICATED`
- JWT 但 `role !== 0` → 403 `FORBIDDEN`
- JWT 過期 → 401 `TOKEN_EXPIRED`(spec 007)

### 4.2 Response

- 成功:`200 OK` + body(JSON;detail = single object,list = paginated envelope)
- not found(detail):`404 NOT_FOUND` 帶 code(`CHARITY_NOT_FOUND` / `DONATION_PROJECT_NOT_FOUND` / `SALE_ITEM_NOT_FOUND`)
  - 重要差異:user-side detail 對 archived/deleted 也回 404(隱藏存在);**admin detail by id 只在 row 真不存在**(無此 id)時回 404
- Validation 失敗(query):`400 VALIDATION_FAILED` 帶 issues
- Server error:`500 INTERNAL`

### 4.3 Cache-Control

- 一律 `Cache-Control: no-store, private`(§2.4)
- 不送 ETag(§1.3 not in scope)

### 4.4 Locale

- 接受 `Accept-Language: zh-TW | en`,預設 `zh-TW`
- 透過 [`pickLocalised`](../../src/lib/i18n/index.ts) helper 從 `name/nameEn`、`description/descriptionEn`、`content/contentEn` 中挑語言

### 4.5 Validation 雙層

對齊 [020 §4.4](./020-donation-write-api.md#44-validation-雙層):

1. **Schema 層**(TypeBox via Fastify):query/params 形狀、enum、min/max
2. **Domain 層**(service):Prisma 查詢 + lifecycle filter helper(`whereForAdmin`)

---

## 5. 各 entity 端點規格

### 5.1 Charity

#### 5.1.1 `GET /cms/donation/charities`

**Query**:

| 欄位 | 型別 | 預設 | 備註 |
|---|---|---|---|
| `limit` | `Type.Integer({ minimum: 1, maximum: 100 })` | 20 | 對齊 [016 §3.2.1](./016-charity-list-api.md);v0.1 admin UI 傳 100 一次撈完 |
| `cursor` | `Type.Optional(Type.String())` | — | base64-encoded `{ createdAt, id }`(對齊 016)|
| `q` | `Type.Optional(Type.String({ maxLength: 80 }))` | — | name + description 全文模糊搜尋(對齊 016) |
| `category` | `Type.Optional(Type.String())` | — | category.key(對齊 016) |
| `includeArchived` | `Type.Optional(Type.Boolean())` | false | true → archived row 也出 |
| `includeDeleted` | `Type.Optional(Type.Boolean())` | false | true → soft-deleted row 也出 |

**Response 200**:`AdminCharityListResponse`(`paginatedEnvelope` 包 `AdminCharityListItem[]`)

**Response shape**(`AdminCharityListItem`):

```ts
{
  id: string,
  name: string,                       // 已挑 locale
  description: string,                // 已挑 locale
  logoUrl: string | null,
  categories: InflatedCategory[],     // 含 archived/deleted category 與否?見 §6.2

  // ── admin metadata ──
  displayOrder: number,
  publishStartAt: string | null,      // ISO datetime
  publishEndAt: string | null,
  archivedAt: string | null,
  deletedAt: string | null,
}
```

#### 5.1.2 `GET /cms/donation/charities/:id`

**Params**:`id: Type.String({ pattern: UUID_V4_PATTERN })`

**Response 200**:`AdminCharityDetail`(超集 of [`CharityDetail`](../../src/schemas/donation-item/detail.ts) `(017 §3)` + admin metadata)

```ts
{
  // 與 public CharityDetail 相同的 9 欄
  id, name, description, logoUrl,
  contactPhone, contactEmail, officialWebsite, approvalNo,
  categories,
  createdAt, updatedAt,

  // admin metadata
  displayOrder: number,
  publishStartAt: string | null,
  publishEndAt: string | null,
  archivedAt: string | null,
  deletedAt: string | null,
}
```

**404**:row 真不存在 → `CHARITY_NOT_FOUND`(對齊 [020 §5.1.2](./020-donation-write-api.md));archived/deleted **不**回 404,正常回 detail(admin 要編輯這些 row)。

### 5.2 DonationProject

#### 5.2.1 `GET /cms/donation/donation-projects`

**Query**:同 5.1.1 + `charityId: Type.Optional(Type.String({ pattern: UUID_V4_PATTERN }))` 可過濾單一 charity 旗下的 project。

**Response**:`AdminProjectListResponse`,row shape = `AdminProjectListItem`:

```ts
{
  id, name, description,
  logoUrl, coverImageUrl,
  charity: { id, name, logoUrl },     // nested charity(同 spec 017 §4.1)
  categories: InflatedCategory[],
  displayOrder, publishStartAt, publishEndAt, archivedAt, deletedAt,
}
```

#### 5.2.2 `GET /cms/donation/donation-projects/:id`

**Response 200**:`AdminProjectDetail`(superset of `ProjectDetail` + admin metadata + 一個額外欄位 `parentCharityArchivedAt`)

```ts
{
  // public ProjectDetail 11 欄
  id, name, description, logoUrl, coverImageUrl, content,
  raisingApprovalNo, reliefApprovalNo,
  charity: { id, name, logoUrl },
  categories,
  createdAt, updatedAt,

  // admin metadata(同 charity 5 欄)
  displayOrder, publishStartAt, publishEndAt, archivedAt, deletedAt,

  // 提示 parent 已 archive(管 UI 顯示警告:此 project 在 public 端因 parent 隱形)
  parentCharityArchivedAt: string | null,
  parentCharityDeletedAt: string | null,
}
```

**為何需要 `parentCharityArchivedAt/DeletedAt`**:cascading visibility(spec 015 v0.9)讓 archived charity 下的 project 在 public 自動隱形;admin 編輯 project 時若不知 parent 已 archive,儲存後仍不會出現,UX 困惑。admin detail response 帶上提示,UI 可顯示警示。

**404**:row 不存在 → `DONATION_PROJECT_NOT_FOUND`。

### 5.3 SaleItem

#### 5.3.1 `GET /cms/donation/sale-items`

**Query**:同 5.2.1。

**Response shape**(`AdminSaleItemListItem`)= AdminProjectListItem + `priceTwd: number`。

#### 5.3.2 `GET /cms/donation/sale-items/:id`

**Response shape**(`AdminSaleItemDetail`)= AdminProjectDetail + `priceTwd: number`(public 已有);admin metadata 5 欄 + parent cascade 2 欄同 5.2.2。

---

## 6. Response shape design

### 6.1 Schema 檔案配置

新檔:

- `src/schemas/donation-item/admin-detail.ts`
  - `export const AdminCharityDetail = Type.Intersect([CharityDetail, AdminLifecycleFields])`
  - `export const AdminProjectDetail = Type.Intersect([ProjectDetail, AdminLifecycleFields, ParentCascadeHints])`
  - `export const AdminSaleItemDetail = Type.Intersect([SaleItemDetail, AdminLifecycleFields, ParentCascadeHints])`
- `src/schemas/donation-item/admin-list-item.ts`
  - 三個 list item schema + 三個 `paginatedEnvelope(items)` response wrapper

```ts
const AdminLifecycleFields = Type.Object({
  displayOrder: Type.Integer(),
  publishStartAt: Type.Union([Type.String(), Type.Null()]),
  publishEndAt: Type.Union([Type.String(), Type.Null()]),
  archivedAt: Type.Union([Type.String(), Type.Null()]),
  deletedAt: Type.Union([Type.String(), Type.Null()]),
})

const ParentCascadeHints = Type.Object({
  parentCharityArchivedAt: Type.Union([Type.String(), Type.Null()]),
  parentCharityDeletedAt: Type.Union([Type.String(), Type.Null()]),
})
```

> 用 `Type.Intersect` 而非複製 public schema 欄位:single source of truth,public schema 若加欄位 admin 自動繼承。

### 6.2 Categories 在 admin response 內

**設計取捨**:
- A. categories 跟 user-side 一樣只回 live(非 archived 非 deleted)→ admin 看不到「此 charity 引用的已封存 category」(可能想 unattach)
- B. 全部 returned + 加 `archivedAt`/`deletedAt` 到 InflatedCategory shape

v0.1 **採 A**(對齊既有 [`inflateCategories`](../../src/domain/donation-item/list-helpers.ts) helper 行為,無新欄位)。Admin 編輯時若想看完整 attach 狀況走 admin Category endpoint(本 spec out of scope,§1.3)。未來若 UX 需求,改 B。

### 6.3 ETag 不發

對齊 §4.3。Public read 用 ETag 配合 conditional GET 提升 cache hit rate;admin 端不快取也不需要客戶端 If-None-Match。

---

## 7. Auth + Rate limit

### 7.1 Auth

對齊 [020 §2.3](./020-donation-write-api.md#23-authjwt-role-0--adminv02);`/cms` scope `requireAdmin` preHandler 已就緒。本 spec 新增的 GET handler 自動套用。

### 7.2 Rate limit(read level — 比 write 寬鬆)

對齊 [020 §11](./020-donation-write-api.md) dual-layer pattern,但 admin read 用獨立 limit:

```ts
const READ_LIMITS = {
  perUser: { limit: 600, windowMs: HOUR },   // 10 req / min / admin
  perIp:   { limit: 3000, windowMs: HOUR },  // 50 req / min / IP
}
```

理由:admin UI 一次 list 看完,detail 點開不過數十次;比 write 寬 10×(write `CREATE_LIMITS = 60/h`)。對齊 010 rate limit module 不必為單一端點客製。

---

## 8. Cache policy

### 8.1 Response Cache-Control

`Cache-Control: no-store, private`(§2.4);Vary `Accept-Language`(實際因 no-store 而無效,但 header 一致性)。

### 8.2 Redis cache 不參與

**寫入端寫入時不清 admin Redis key**(因為沒有 admin Redis key)。對齊 [019 §8](./019-cache-policy.md) cache invalidation map:本 spec 不在 map 表內。

### 8.3 為何也不對 admin endpoint 加 ETag

詳見 [§2.4](#24-為什麼-admin-endpoint-不快取) 與 [§1.3](#13-out-of-scope)。

---

## 9. Test cases

### 9.1 Auth gate(對齊 spec 020 §13.2 表頭)

| # | 案例 | 期望 |
|---|---|---|
| A1 | 無 JWT → GET list | 401 UNAUTHENTICATED |
| A2 | role=1 JWT → GET list | 403 FORBIDDEN |
| A3 | role=1 JWT → GET detail | 403 |
| A4 | role=0 admin JWT → GET list / detail | 200 |

### 9.2 List(charity)

| # | 案例 | 期望 |
|---|---|---|
| L1 | seed 5 live + 2 archived + 1 deleted;`?limit=100`(無旗標)→ 回 5(只 live) | `whereForAdmin` 預設行為 |
| L2 | `?limit=100&includeArchived=true` → 回 7(5+2 archived) | filter open |
| L3 | `?limit=100&includeDeleted=true` → 回 6(5+1 deleted) | filter open |
| L4 | `?includeArchived=true&includeDeleted=true` → 回 8 | 全集 |
| L5 | `?q=keyword` → 模糊搜尋(對齊 spec 016 已測 — admin 沿用同 service) | search |
| L6 | response 每筆含 `displayOrder` / `publishStartAt` / `publishEndAt` / `archivedAt` / `deletedAt` | admin shape |

### 9.3 Detail(charity)

| # | 案例 | 期望 |
|---|---|---|
| D1 | seed live charity → `GET /:id` → 200 + admin shape | happy |
| D2 | seed archived charity → `GET /:id` → 200(**不**404)+ `archivedAt` non-null | 對比 public 隱藏 |
| D3 | seed soft-deleted charity → `GET /:id` → 200 + `deletedAt` non-null | 同上 |
| D4 | non-existent uuid → 404 CHARITY_NOT_FOUND | 真不存在 |
| D5 | malformed id(non-uuid)→ 400 VALIDATION_FAILED | TypeBox params |

### 9.4 Detail(project / item — cascading hint)

| # | 案例 | 期望 |
|---|---|---|
| D6 | seed archived charity + 旗下 live project → `GET /donation-projects/:id` → 200 + `parentCharityArchivedAt` non-null | cascade hint |
| D7 | seed live charity + 旗下 deleted project → 200 + project.deletedAt non-null + parentCharity*At=null | row state vs parent state |

### 9.5 Rate limit

| # | 案例 | 期望 |
|---|---|---|
| R1 | admin 連送 601 次 → 第 601 次回 429 | per-user limit |
| R2 | 同 IP 不同 admin 共送 3001 次 → 第 3001 次回 429 | per-IP limit |

### 9.6 Locale

| # | 案例 | 期望 |
|---|---|---|
| I1 | seed `name='中文', nameEn='English'` + `Accept-Language: zh-TW` → name 為「中文」 | locale picker |
| I2 | 同上 + `Accept-Language: en` → name 為「English」 | |
| I3 | 缺 header → 預設 zh-TW | default |

### 9.7 Cache behaviour

| # | 案例 | 期望 |
|---|---|---|
| C1 | 連續兩次 GET → 第二次 response time 與第一次相近(無 Redis cache 提速;DB 都會打) | no-cache 證據 |
| C2 | response header `Cache-Control: no-store, private` | header |
| C3 | PATCH 一筆 charity 後立即 GET admin detail → 顯示新值(無 stale cache 風險) | freshness |

---

## 10. 開放問題

- **Admin Category list endpoint**:本 spec out of scope(§1.3);若 admin 需要編輯 charity 的 archived category 引用、看完整 category 池,需另 spec(可挂在 020 lifecycle action endpoint 同層)
- **未來 audit log endpoint**:同 020 OQ #4
- **包含 `User` info 的 list response**(誰建立 / 最後修改)?目前 schema 無 `createdBy` / `updatedBy` 欄位(spec 015 也沒);加進去屬 audit log family,未來 ADR
- **Bulk get by ids**(`?ids=a,b,c`):admin UI 若想 batch 刷新(如 lifecycle action 後)可能需要;v0.1 用 6 個 endpoint 各 fetch 即可
- **`If-Modified-Since`**:若未來 admin UI 用 SSE / polling 監聽 lifecycle 變動,值得加。v0.1 不做
- **`whereForAdmin` 對 Charity vs Project vs SaleItem 共用同一個 generic helper 還是各寫一份**:本 spec 範例只寫 Charity;實作時看 Prisma 型別是否能 generic 化(Project / SaleItem 沒有 publishStartAt 嗎?有)。本 spec 規劃為 generic + 各 entity 從 helper 拿同樣 4 條件
- **admin endpoint 失敗時 error code 是否要不同於 public**(如 `CHARITY_NOT_FOUND` vs `ADMIN_CHARITY_NOT_FOUND`):v0.1 共用 code,理由是 404 本質意義一致;若未來想做 admin 專屬 error mapping(如不同 toast 文案),再加

---

## 11. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-16 | 初版:補 6 個 admin GET endpoint(charity / project / item 各 list + detail)解 [FE spec 011 §5.4](../../../frontend/docs/specs/011-cms-resource-admin.md#54-be-硬依賴backendcharitydetail-缺欄位) hard prerequisite。新增 `whereForAdmin` helper(對應 spec 015 §3.3 v0.9 已 spec 但未實作)+ `AdminCharityDetail` / `AdminProjectDetail` / `AdminSaleItemDetail` TypeBox schema(Intersect public schema + admin metadata 5 欄)+ list item schema 三件 + paginatedEnvelope wrapper。Auth 沿用 [020 §2.3](./020-donation-write-api.md) `/cms` scope `requireAdmin`,rate limit 走 `READ_LIMITS`(per-user 600/h / per-IP 3000/h,比 write 寬 10×)。Cache:admin endpoint **不** 走 Redis,response `Cache-Control: no-store, private`,不發 ETag。Project / SaleItem detail 額外帶 `parentCharityArchivedAt/DeletedAt` 兩欄,提示 admin parent 已 archive / delete(配合 spec 015 v0.9 cascading visibility)。Test plan:auth 4 case / list 6 case / detail 7 case / rate limit 2 case / locale 3 case / cache 3 case = 25 case 涵蓋 §9 |
