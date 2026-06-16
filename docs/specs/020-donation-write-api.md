# Spec 020:Donation Domain Write API(Charity / Project / SaleItem / Category)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.3 |
| 日期 | 2026-06-15 |
| 適用範圍 | `backend/src/routes/v1/donation/**/*.ts`(write handlers,新增)、`backend/src/domain/donation-item/write-services.ts`(新增)、`backend/src/domain/category/write-services.ts`(新增)、`backend/src/lib/cache/invalidate-donation.ts`(新增)|
| 相關 ADR | 待補(預計 `docs/decisions/012-donation-write-surface.md` — 若需要把「無 auth 寫入」這個決策獨立 ADR)|
| 相關 spec | `015-charity-data-model.md` v0.10(欄位、constraint、lifecycle)、`016-charity-list-api.md`(public read list)、`017-detail-apis.md`(public read detail)、`018-storage-module.md`(presign / S3 key pattern)、`019-cache-policy.md`(invalidation map §8.3)、`005-error-handling.md`(error code 與 RFC 7807)|

---

## 1. 目的與範圍

> **URL prefix(spec 023 §2 已落地)**:本 spec 列的 endpoint path **不含 surface prefix**。實際 client URL 依 surface 加前綴:
> - Public read endpoints → `/user/v{N}/...`(spec 023 §2.2;當前 `v1`)
> - Admin write endpoints → `/cms/...`(spec 023 §2.3,scope-level `requireAdmin` 由 `/cms` plugin attach)
> - Auth endpoints → `/auth/...`(spec 023 §2.1,不版本化)
>
> Endpoint URL 完整 mapping 表見 spec 023 §2.4。

### 1.1 目的

把目前完全 read-only 的 donation 領域(spec 016 / 017)補上寫入端,使資源能透過 HTTP API 完整管理:**新增 / 修改 / 封存 / 刪除**。本期**不**做 admin 角色 / 權限控管 — 端點為公開可呼叫(見 §2.3 與風險)。

### 1.2 In scope

- Charity / DonationProject / SaleItem 各 6 個寫入端點(create / patch / archive / unarchive / delete / restore)
- Category 5 個寫入端點(patch / archive / unarchive / delete / restore;**無 create**,見 §2.5)
- Domain layer 新增 `write-services` 模組(對應既有 `list-services` / `detail-services` 純函式定位)
- Cache invalidation 統一 helper(實作 spec 019 §8.3 規約)
- 與 spec 018 presign 串接(圖檔 key 由 client 預先 PUT,write API 寫進 DB)
- TypeBox 驗證(route layer)+ 業務驗證(domain)雙層
- Audit logging(log-only,沿用 spec 004)

### 1.3 Out of scope(本期不做,點明位置)

- **Auth / Admin role**:**無**任何端點驗證。使用者選擇此設定,風險與緩解見 §2.3
- 圖檔本體上傳:走 spec 018 presign,write API 只收 S3 key
- S3 orphan 清理:寫入端不會 delete 舊 logoKey 對應的 S3 object(spec 015 §10 已有 lifecycle 解耦的決策)
- Hard delete / GDPR retention:只做 soft delete,hard delete 留給未來 ADR + admin
- Audit table(DB-persisted history):本期靠 logger;未來如有合規需求再加表
- Bulk operations:純單一資源端點;批次留給未來

---

## 2. 架構評估(Architecture Decisions)

### 2.1 既有層次梳理

```
┌─ HTTP boundary
│
├─ routes/v1/donation/*           Fastify route handlers
│      └─ 既有:GET handlers(list / detail / categories)
│      └─ 新增:POST / PATCH / DELETE handlers(本 spec)
│
├─ services/cached-*              Cache-aside adapter(spec 019 §2.2)
│      └─ 既有:listCachedCharities / getCachedCharityById / ...
│      └─ 新增:**無**(write path 不經 cache,而是 invalidate)
│
├─ domain/donation-item/          純函式業務邏輯(只吃 Prisma)
│      └─ 既有:list-services.ts / detail-services.ts
│      └─ 新增:write-services.ts(本 spec §5)
│
├─ domain/category/
│      └─ 既有:list.ts
│      └─ 新增:write-services.ts(本 spec §5.4)
│
├─ lib/cache/                     Cache primitives
│      └─ 既有:withCache / invalidate(per-key)
│      └─ 新增:invalidate-donation.ts(per-entity 批次失效,封裝 spec 019 §8.3)
│
└─ Prisma + Redis + S3            Infrastructure
```

### 2.2 為什麼 write-services 放在 `domain/` 而不是 `services/`

| 候選 | 結論 |
|---|---|
| `domain/donation-item/write-services.ts`(採用)| 與既有 list / detail services 並列;對 Prisma 純依賴;**可純 integration test 不需 redis** |
| `services/admin-*.ts` | 仿造 cached-*;但 write 不需 cache 邏輯,放在這層就是 adapter 形式偽裝 |
| 直接在 route handler | route 變肥 + 業務邏輯散落;單元測試只能 inject mock |

**規約**(對齊 spec 019 §2.2 / CLAUDE.md「純函式 → unit;牽涉 Redis → integration」):

- write-service **只**依賴 `prisma`,**不**依賴 redis / s3 client(spec 015 §10 — DB 是 SoT)
- Cache invalidation 在 route handler 呼叫 `invalidateDonationEntity()`(§8 新 helper),write-service 不知道有 cache 存在
- 圖檔 S3 物件由 client 走 spec 018 presign 預先 PUT,write API 只 validate `logoKey` / `coverImageKey` 格式 + 寫進 DB

### 2.3 Auth:JWT role 0 = ADMIN(v0.2)

本期端點**全部**需要 `Authorization: Bearer <access-jwt>`,且 JWT 內必須帶 `role === 0`(ADMIN)。其他 role(包含未帶 role claim 的舊 token)→ **403 `FORBIDDEN`**。

#### Role 常數定義

實作放在 `src/lib/auth/role.ts`(本 spec 落地時建立):

```ts
export const Role = {
  ADMIN: 0,
  USER: 1,
} as const

export type RoleValue = (typeof Role)[keyof typeof Role]
```

設計取捨:

- **用 const literal 而非 Prisma enum**:demo 階段角色集合穩定(0 / 1 兩個),改用 enum 反而增加 schema migration 摩擦;未來如需 `MODERATOR` / `SUPPORT` 細分再升級為 enum(已記錄於 §14 OQ #1)
- **0 = ADMIN 不是 1 = ADMIN**:純命名選擇;0 在「沒有 role claim 的舊 JWT」時不會誤判為 admin(JS 中 `undefined === 0` 為 false),fail-safe
- **JWT 攜帶 `role`**:從 DB `Account.role` 讀,在 `signAccessToken`(spec 007 §11.1)時 embed 進 claim;refresh 路徑下 issueBundle 時重新從 DB 讀 role,避免被 admin 中途降級後 access 仍有效

#### 「JWT 限後台」的範圍

`role=0` 的 access JWT **僅用於本 spec 23 個 admin 寫入端點**。其他端點:

| 端點 | role=0 JWT 行為 |
|---|---|
| Public read(`/v1/donation/*` GET) | 接受但不檢查 role — 公開端點任何 caller 都能讀 |
| Self-service(`/auth/me/*` 所有動作,spec 008 §6.4-§6.7)| **同樣接受 role=0 JWT**(admin 自己也是 Account,可改自己 profile / archive 自己) |
| 認證類(`/auth/login` / refresh / logout)| 不檢查 role |
| Upload presign(`/v1/donation/uploads/presign`) | **本期建議加 admin gate**(只有 admin 上傳圖檔有意義);實作落在 spec 018 補丁(本 spec 列為 §14 OQ #11)|

#### 風險變動(對比 v0.1 無 auth)

| 原風險 | v0.2 緩解狀況 |
|---|---|
| 任何 client 都能 create / delete | ✅ 解決 — 需 ADMIN JWT |
| 自動化掃描 POST 假資料 | ✅ 解決 — 無 admin JWT 不過 |
| 誤呼 DELETE 砍 charity | 部分緩解 — admin 仍可誤刪;soft delete + restore 兜底 |

#### 新風險

| 風險 | 緩解 |
|---|---|
| 第一個 admin 怎麼出現? | bootstrap script / seed 寫死一筆;落地細節留 §14 OQ #10 |
| Admin 被降級後 access JWT 在 TTL 內(≤ 3h, ADR 004)仍有效 | 對齊 spec 007 §10.9 已知 zombie-session 視窗;接受同樣 trade-off,**不**做 access blacklist |
| Admin 帳號被盜 → 災難性 | rate-limit + audit log(§12)兜底偵測;未來如需更強再加 MFA / IP allowlist(本 spec §14 OQ #1) |

### 2.4 URL pattern

| 候選 | 評估 |
|---|---|
| `/v1/donation/{resource}` 與既有 read 同 path(採用) | method 區分 read / write;符合 RESTful 慣例;未來加 admin 認證直接套 preHandler 不改 path |
| `/admin/v1/donation/{resource}/*` | 隔離乾淨,但目前無 admin 概念,前綴沒語意支撐 |
| `/v1/manage/donation/*` | 自造前綴,讓 client 混亂 |

→ 採用 `/v1/donation/*`。BFF / client 從 HTTP method 區分,符合 REST。

### 2.5 為什麼 Category 沒有 create

Category 的 `key` 欄位在 TypeScript 端是 const literal union(`src/domain/category/keys.ts` 的 `CATEGORY_KEYS` 16 個),被 spec 016 §5.1 與 spec 017 §2 的 filter validator 引用。runtime 加 key 會:

- 寫入的 key 無法被任何 public read endpoint(`?category=<key>`)查詢到 — `parseCategoryKey` 直接 reject
- ADR 002(charity-category-model)選 key-based contract 是「業務語意 stable」的決策,動態化等同推翻

→ Category 新增 key 仍走「seed 編輯 + migration + code update(`CATEGORY_KEYS` array)+ spec 016 §5.1 同步」的固定流程,**不**透過 runtime API。

runtime Category PATCH 只允許改 `displayName` / `displayNameEn` / `displayOrder`;lifecycle(archive / unarchive / delete / restore)仍可動。

### 2.6 Lifecycle action 設計取捨

| 議題 | 決策 |
|---|---|
| 用 PATCH archivedAt 直接設?還是 POST action 端點? | **POST action**(對齊 spec 008 §6.7 `/auth/me/archive` 的決策)— 不暴露 lifecycle timestamp 為 PATCH 可寫欄位,避免 client 寫 `archivedAt: "2030-01-01"` 排程封存 |
| archive / unarchive / delete / restore 四個動作是否 idempotent? | **是**。已封存的再 archive → 200 no-op;已刪除的再 delete → 200 no-op。透過 helper 寫 `WHERE archivedAt IS NULL` 條件 update + check rowcount |
| archive 已被 deleted 的 row?delete 已被 archived 的? | **允許**。兩個 timestamp 互不依賴;可以同時非 null。Public read 仍正確隱藏(whereLive 用 OR) |
| restore 同時清掉 archive 嗎? | **不會**。restore 只動 `deletedAt`,unarchive 只動 `archivedAt`;互相不污染 |
| 動作端點是否影響 `publishStartAt` / `publishEndAt`? | **否**。後者是內容上下架排程(spec 015 §3),lifecycle 動作不碰 |

### 2.7 Concurrency:Last-writer-wins

本期不做 optimistic locking。多個 client 同時 PATCH 同一 charity:

- Prisma 的 update 是 atomic at row level → 不會 partial update
- 最後一筆 write 勝;`updatedAt` 自動更新
- ETag 在 read 端發出但 write 端**不**驗證 `If-Match`(本期沒有 admin UI 用 ETag concurrency)
- 未來引入 admin UI 時補 `If-Match` → 412 Precondition Failed

### 2.8 Image 上傳整合(spec 018 presign)

寫入流程不接圖檔 binary:

```
1. Client: GET /v1/donation/uploads/presign?entity=charities&purpose=logo&ext=png
                                          ↓ (spec 018 §7)
2. Backend: 回 { url, key, fields, method:PUT, expiresIn }
3. Client: PUT image to S3 directly using returned url + fields
4. Client: POST /v1/donation/charities { ..., logoKey: <返回 key> }
                                          ↓ (本 spec)
5. Backend: validate logoKey regex + entityId 對應 + persist
```

write API 規約:
- `logoKey` / `coverImageKey` 必須匹配 spec 018 §5.1 的 regex pattern(`^donation/(charities|donation-projects|sale-items)/[0-9a-f-]{36}/(logo|cover)\.(png|jpg|jpeg|webp|gif)$`)
- 但**不**對 S3 做 HEAD 驗證物件存在(理由:多一次 round trip + 容錯複雜;接受「DB key 指向不存在 object 由 cdn 報 404」的 trade-off,與 spec 018 §11 一致)
- 對 PATCH 上的 logoKey 變更:write API **不**刪除舊 S3 object — orphan 清理走 lifecycle policy(spec 018 §13 / 本 spec §15 開放問題)

---

## 3. 端點清單

```
Charity (6)
  POST   /v1/donation/charities                       create
  PATCH  /v1/donation/charities/:id                   update
  POST   /v1/donation/charities/:id/archive           set archivedAt=NOW()
  POST   /v1/donation/charities/:id/unarchive         clear archivedAt
  DELETE /v1/donation/charities/:id                   set deletedAt=NOW() (soft)
  POST   /v1/donation/charities/:id/restore           clear deletedAt

DonationProject (6) — 同 pattern,/v1/donation/donation-projects
SaleItem (6) — 同 pattern,/v1/donation/sale-items

Category (5)
  PATCH  /v1/donation/categories/:id                  update (displayName / displayNameEn / displayOrder)
  POST   /v1/donation/categories/:id/archive
  POST   /v1/donation/categories/:id/unarchive
  DELETE /v1/donation/categories/:id
  POST   /v1/donation/categories/:id/restore

合計 23 個新端點。
```

---

## 4. 共通 Request / Response 慣例

### 4.1 Body shape 原則

| 動作 | Body | 備註 |
|---|---|---|
| **POST**(create) | 完整可選欄位,**required 欄位皆需提供** | 對齊 spec 015 NOT NULL 欄位 |
| **PATCH**(update) | **全部 optional**,只動有提供的欄位;`null` = 清空(對 nullable 欄位) | TypeBox `Type.Partial` 不可直接用(因 nullable 與 optional 不同),手動展開 |
| **POST `/archive` / `/unarchive` / `/restore`** | 無 body | 純動作 |
| **DELETE** | 無 body | |

### 4.2 Response shape

| 動作 | Status | Body |
|---|---|---|
| POST create | 201 + `Location: /v1/donation/{resource}/:id` | **完整 detail body**(對齊 spec 017 detail response) |
| PATCH update | 200 | 完整 detail body |
| POST archive / unarchive / delete / restore | 204 | 空 body(動作純改 lifecycle) |

不回 ETag(write response 的 ETag 對 client cache 無價值;client 收到 200/201 後自然會用最新 body)。

### 4.3 Idempotency

| 動作 | Idempotent? | 行為 |
|---|---|---|
| POST create | ❌ 不(每次 create 新 row,新 UUID) | 提供 `Idempotency-Key` header 是未來工作 |
| PATCH update | ✅(same body,same result) | last-writer-wins |
| POST archive | ✅ | 已 archived → 200 no-op |
| POST unarchive | ✅ | 已 unarchived → 200 no-op |
| DELETE | ✅ | 已 deleted → 200 no-op(注意:不是 204,因為 200 表示 found + idempotent;若想嚴格 204 always 也可,本 spec 採 200 與其他 idempotent 一致) |
| POST restore | ✅ | 已 restored → 200 no-op |

實作建議:lifecycle action 用 `prisma.update({ where: { id, <lifecycleField>: null } })`,然後 check update count;count=0 表示「已是該狀態」,直接 200。

### 4.4 Validation 雙層

| 層 | 負責 |
|---|---|
| TypeBox schema(route 層) | shape + 長度 / 格式 / pattern;失敗 → 400 `VALIDATION_FAILED`(spec 005) |
| Domain write-service | FK 存在性(charityId 對應 Charity row 存在)、unique constraint(其實由 DB 接,但 service 轉成 `CONFLICT`)、Category key 白名單對 M:N |

---

## 5. 各 entity 端點規格

### 5.1 Charity

#### 5.1.1 `POST /v1/donation/charities`

**Required**(對齊 spec 015):
- `name` (zh,1-120 chars,trim)
- `description` (zh,1-500 chars)

**Optional**:
- `nameEn`、`descriptionEn`(雙語,spec 015 v0.7)
- `contactPhone`、`contactEmail`、`officialWebsite`、`approvalNo`(v0.6 IMG_4876)
- `logoKey`(spec 018 regex 驗證)
- `displayOrder`(int,default 0)
- `publishStartAt`、`publishEndAt`(ISO 8601 datetime)
- `categoryIds`(`string[]` of UUID;empty = 不關聯任何 category)

**禁止 client 提供**:
- `id`(server 端 uuid 生成)
- `createdAt`、`updatedAt`(server-managed)
- `archivedAt`、`deletedAt`(用 action 端點,§7)

**流程**:
```
validate body (TypeBox)                          ← 400 VALIDATION_FAILED
domain.createCharity({ ...body, categoryIds })   ← 內部開 transaction
  insert charity row
  for each categoryId in categoryIds:
    insert charityOnCategory(charityId=new, categoryId)
                                                 ← 若 categoryId 不存在 → 400 CATEGORY_NOT_FOUND(新 code)
                                                 ← 若 logoKey 對應 charityId 與本 row 不符 → 400 INVALID_S3_KEY_BINDING
  build response (含 inflated categories)
invalidate cache(§8)
→ 201 + Location + detail body
```

#### 5.1.2 `PATCH /v1/donation/charities/:id`

每個欄位是 absent / `null` / 新值三態:
- absent → 不動
- `null` → 清空(僅對 nullable 欄位,例:`logoKey: null` 清空 logo)
- 新值 → 設定

**禁止改**:`id`、`createdAt`、`updatedAt`、`archivedAt`、`deletedAt`(後二者走 action)

**categoryIds**:absent → 不動;新 array → **全替換**(刪除所有舊 join row,新增提供的)

**流程**:
```
validate body (TypeBox,所有欄位 optional + nullable for nullable cols)
domain.updateCharity(id, patch)
  findUnique by id → 404 CHARITY_NOT_FOUND if missing
  transaction:
    update charity row with non-undefined fields
    if categoryIds present:
      deleteMany charityOnCategory where charityId
      insertMany charityOnCategory for each new categoryId
  build response
invalidate cache(§8)
→ 200 + detail body
```

#### 5.1.3 `POST /v1/donation/charities/:id/archive`

```
domain.archiveCharity(id)
  update charity SET archivedAt=NOW()
    WHERE id=? AND archivedAt IS NULL
  rowcount === 0 ? already archived (idempotent no-op)
                 : invalidate cache
→ 200(無 body)
```

#### 5.1.4 `POST /v1/donation/charities/:id/unarchive`

```
domain.unarchiveCharity(id)
  update charity SET archivedAt=NULL
    WHERE id=? AND archivedAt IS NOT NULL
  invalidate cache if rowcount > 0
→ 200(無 body)
```

#### 5.1.5 `DELETE /v1/donation/charities/:id`

```
domain.softDeleteCharity(id)
  update charity SET deletedAt=NOW()
    WHERE id=? AND deletedAt IS NULL
  invalidate cache if rowcount > 0
→ 200(idempotent;rowcount=0 也回 200)
```

#### 5.1.6 `POST /v1/donation/charities/:id/restore`

```
domain.restoreCharity(id)
  update charity SET deletedAt=NULL
    WHERE id=? AND deletedAt IS NOT NULL
  invalidate cache if rowcount > 0
→ 200
```

### 5.2 DonationProject

對應 spec 015 §3.2 模型 + spec 017 §4.

**POST required**:
- `charityId`(UUID,**外部 FK 必須存在**)
- `name`、`description`(zh)
- `content`(zh,可長文)

**Optional**:全 spec 017 §4 detail 欄位的 nullable 版本

**驗證**:
- `charityId` → Charity 必須存在(否則 400 `CHARITY_NOT_FOUND`)
- ⚠ 不強制 parent Charity 為 live;允許在 archived charity 下建 project(admin 工作流)— 但這 project 仍會因 cascading visibility 在 public read 中隱形

其餘 5 個動作模式同 §5.1.3 ~ §5.1.6,把 charity 換成 donation_project。

### 5.3 SaleItem

同 §5.2,額外:
- `priceTwd` Int,POST required(非負)
- `coverImageKey` 對 sale-item 是必要的視覺;但本 spec 仍標 optional(對齊 spec 015 nullable)

### 5.4 Category(5 endpoint,無 create)

#### 5.4.1 `PATCH /v1/donation/categories/:id`

**允許改**:
- `displayName`、`displayNameEn`、`displayOrder`

**禁止改**:
- `key`(TypeScript const 字面值;runtime 改 key 不可能)
- `id`、`createdAt`、`updatedAt`、`archivedAt`、`deletedAt`

**流程**:
```
validate body
domain.updateCategory(id, patch)
  findUnique → 404
  update
  build response(對齊 spec 016 §6.2 CategoryListItem shape)
invalidate cache
→ 200 + category response
```

#### 5.4.2 ~ 5.4.5 archive / unarchive / delete / restore

同 §5.1,目標 entity = category。

**特殊**:Category 是字典表,被 charity_categories M:N 引用。delete 一個 category **不** cascade 刪除 join row(spec 015 §3.4 已定 `onDelete: Restrict` 對 Category — hard delete 會被擋,但 soft delete 不會,反正 join row 還在,前端 public read 端點透過 `where: { category: { deletedAt: null, archivedAt: null } }` 過濾掉,nested categories 就消失了 — 與 spec 017 §3.1 邏輯一致)。

---

## 6. Validation rules 對齊表

| 欄位 | 來源 spec | TypeBox 約束 | Domain 約束 |
|---|---|---|---|
| `name` | spec 015 §3.1 | 1-120 chars,trim 後非空 | 同 |
| `description` | spec 015 §3.1 | 1-500 chars | 同 |
| `content` | spec 015 §3.2 | 1-50000 chars | 同 |
| `nameEn` / `descriptionEn` / `contentEn` | spec 015 v0.7 | nullable,有值 → 同 zh 長度 | 同 |
| `contactPhone` | spec 015 v0.6 | nullable,有值 → 1-30 chars | (不驗格式,因國際電話形式雜) |
| `contactEmail` | spec 015 v0.6 | nullable,有值 → email format,≤ 254 | 同 |
| `officialWebsite` | spec 015 v0.6 | nullable,有值 → http(s) URL,≤ 2048 | 同 |
| `approvalNo` | spec 015 v0.6 | nullable,有值 → 1-100 | (不驗格式) |
| `logoKey` / `coverImageKey` | spec 018 §5.1 | nullable,有值 → 對應 regex pattern | 對應 entity & id 必須 match path |
| `displayOrder` | spec 015 v0.9 | int,範圍 `-1000 ~ 1000` | 同 |
| `publishStartAt` / `publishEndAt` | spec 015 v0.9 | nullable,有值 → ISO 8601 datetime | end > start(若兩者皆設) |
| `priceTwd` | spec 015 v0.6 | int,≥ 0,≤ 10_000_000 | 同 |
| `raisingApprovalNo` / `reliefApprovalNo` | spec 015 v0.6 | nullable,1-100 | (不驗格式) |
| `categoryIds` | spec 015 §3.3 | UUID v4 array,length 0-16 | 每個 ID 必須對應 live Category |

---

## 7. Lifecycle action 統一規約

### 7.1 單欄位原則

每個 action 只改它對應的欄位:

| Action | 改 | 不改 |
|---|---|---|
| `archive` | `archivedAt = NOW()` | `deletedAt` / publish 時段 |
| `unarchive` | `archivedAt = NULL` | 同上 |
| `delete` | `deletedAt = NOW()` | `archivedAt` / publish 時段 |
| `restore` | `deletedAt = NULL` | 同上 |

### 7.2 雙態並存

`archivedAt` 與 `deletedAt` 互不依賴。可以同時非 null,可以分別獨立操作。Public read 的 `whereLive` 用 OR 過濾:任一非 null → 隱藏。

### 7.3 Idempotent via WHERE clause

實作每個 action 都用 conditional update:

```sql
UPDATE charities
   SET archivedAt = NOW()
 WHERE id = $1 AND archivedAt IS NULL
```

rowcount === 0 表示「已是目標狀態」→ 跳過 cache invalidate,直接 200。**不**為「已是目標狀態」回 409。

### 7.4 父子聯動

archive / delete 父 Charity 之後:
- 子 DonationProject / SaleItem **資料不動**(`whereLive` cascade 已在 public read 端做)
- 但 **public list cache 必須失效**(spec 019 §8.3 cascading invalidation)

→ §8 cache invalidate map 已涵蓋。

---

## 8. Cache invalidation(對齊 spec 019 §8.3)

### 8.1 Per-entity 失效 key 表

| 寫入 entity | DEL 的 key pattern |
|---|---|
| Charity(create / update / 4 lifecycle actions) | `cache:char:detail:v1:{id}:zh-TW` + `:en` + 所有 `cache:char:list:v1:{cat}:zh-TW/en` + 所有 `cache:proj:list:v1:{cat}:{charityIdOrAll}:zh-TW/en`(cascading) + 所有 `cache:sale:list:v1:{cat}:{charityIdOrAll}:zh-TW/en`(cascading) |
| DonationProject(同上 6 動作) | `cache:proj:detail:v1:{id}:zh-TW` + `:en` + 所有 `cache:proj:list:v1:{cat}:{charityIdOrAll}:zh-TW/en` |
| SaleItem(同上 6 動作) | `cache:sale:detail:v1:{id}:zh-TW` + `:en` + 所有 `cache:sale:list:v1:{cat}:{charityIdOrAll}:zh-TW/en` |
| Category(5 動作) | 所有 `cache:cat:list:v1:zh-TW` + `:en`;categories 動作**也**影響 charity / project / sale 的 nested categories,但因 cache value 用 ETag co-stored,簡化處理:`cache:char:detail:v1:*` + `cache:proj:detail:v1:*` + `cache:sale:detail:v1:*` 都 DEL(這是 worst case,可接受 — category 動作頻率低) |

### 8.2 List 白名單枚舉

按 spec 019 §4.2,list 白名單為:

```
無 cursor + 預設 pageSize + category ∈ {ALL, 16 個 key} + charityId=ALL + locale ∈ {zh-TW, en}
```

Charity list 白名單 key 數:`17 categories × 1 (charityId=ALL only) × 2 locales = 34 keys`
Project list 白名單 key 數:同上 = 34
SaleItem list 白名單 key 數:34
Cat list:2 keys

**每次 Charity 寫入觸發的 DEL 數量**(最壞):
- detail(自己): 2
- char list:34
- proj list:34(cascading)
- sale list:34(cascading)
- **合計 ~104 keys**

Redis MGET/DEL 102 keys 是 sub-millisecond 操作。無 SCAN 風險(白名單枚舉)。

### 8.3 實作:`invalidateDonationEntity()` helper

新檔 `src/lib/cache/invalidate-donation.ts`:

```ts
export type DonationEntity = 'charity' | 'project' | 'sale' | 'category'

export interface InvalidationContext {
  redis: Redis
  logger: FastifyBaseLogger
  /** Entity 與寫入的 id;cascading 規則內部處理 */
  entity: DonationEntity
  id: string
}

export async function invalidateDonationEntity(ctx: InvalidationContext): Promise<void>
```

實作走 pipeline 批量 DEL;每個 invalidate 失敗(redis down)記 warn log,不 throw — 對齊 spec 019 §9.1 的降級政策。

### 8.4 Category Key 列表的 single source of truth

`invalidateDonationEntity` 需要枚舉 16 categories + ALL。這份名單必須與 `src/domain/category/keys.ts` 的 `CATEGORY_KEYS` 同步。實作層面:

```ts
import { CATEGORY_KEYS } from '../../domain/category/keys.js'
const CACHE_LIST_SLOTS = ['ALL', ...CATEGORY_KEYS] as const  // 17 個 slot
```

新增 category key 走 spec 015 §7 + code change,該檔變動會自動連動 invalidate 名單,不會 drift。

---

## 9. 與 spec 018 presign 的協作

### 9.1 Client side flow

1. `GET /v1/donation/uploads/presign?entity=charities&purpose=logo&ext=png`
2. 收到 `{ url, key, fields, expiresIn }`(spec 018 §7)
3. Client `PUT` 圖檔到 S3
4. 將 `key` 放進 `POST /v1/donation/charities` 的 `logoKey`
5. Backend 驗 key 的 entity / id 對應(write-service 內)

### 9.2 Backend 不驗 S3 物件存在性

接受 trade-off:DB key 可能指向不存在的 S3 物件(client 跳過 step 3 或 fail mid-upload)。前端遇到 404 logoUrl 顯示 default avatar(spec 015 v0.10 — featured-only logo 已建立此 fallback)。

### 9.3 PATCH logoKey 變更時不刪舊 S3 object

理由與 spec 018 §13 一致:

- DELETE S3 object 需要 IAM permission `s3:DeleteObject`,目前 backend ECS role 不持有(spec 018 §5)
- orphan 清理走 S3 lifecycle policy(時間到期自動刪)或一次性 admin script(spec 015 v0.10 的 `cleanup-orphan-charity-logos.ts` pattern)

---

## 10. Error codes(對齊 spec 005 §4.2)

新增 codes(寫進 `src/lib/errors/codes.ts`):

| Code | HTTP | 場景 |
|---|---|---|
| `CHARITY_CATEGORY_INVALID` | 400 | POST / PATCH 提供的 `categoryIds` 含不存在或非 live 的 Category |
| `INVALID_S3_KEY_BINDING` | 400 | `logoKey` / `coverImageKey` 的 entity/id segment 與 path / body 不符 |
| `INVALID_LIFECYCLE_RANGE` | 400 | `publishStartAt >= publishEndAt`(若兩者皆設) |

沿用既有:
- `VALIDATION_FAILED`(400)— TypeBox 驗證失敗
- `CHARITY_NOT_FOUND` / `DONATION_PROJECT_NOT_FOUND` / `SALE_ITEM_NOT_FOUND`(404)
- `CATEGORY_UNKNOWN`(400)— 仍用於 public read 端點的 `?category=` filter,write 端用新的 `CHARITY_CATEGORY_INVALID` 區分

---

## 11. Rate limit(spec 010 框架)

v0.2 已有 ADMIN JWT gate(§2.3),非 admin 直接 403,rate-limit 主要防「admin 帳號被盜後的自動化爆量」。

| 端點群 | per-User(ADMIN account)| per-IP(兜底,防多帳號被盜)|
|---|---|---|
| create | **60 / hour** | 300 / hour |
| update | **120 / hour** | 600 / hour |
| lifecycle action(archive / unarchive / delete / restore)| **60 / hour** | 300 / hour |
| Category 全動作 | **30 / hour** | 100 / hour |

調整理由:有 auth gate 後不再擔心匿名掃描,quota 可放寬到「人類管理員實際操作上限」級別;爆量同時觸 per-user(代表單 admin 帳號異常)與 per-IP(代表多 admin 同時被盜)兩道警鈴。

---

## 12. Audit(沿用 spec 004 logger)

每次寫入 emit pino event:

| Event | 觸發點 | level | audit |
|---|---|---|---|
| `donation_charity_created` | POST charity | info | ✅ |
| `donation_charity_updated` | PATCH charity | info | ✅ |
| `donation_charity_archived` / `_unarchived` / `_deleted` / `_restored` | 對應 action | info | ✅ |
| 同樣 pattern 為 project / sale / category 各 6 / 5 個 event | — | — | — |

Event payload 含 `entityId`,**禁止**含 raw body(避免敏感欄位如 `contactEmail` 落 log;這些已在 spec 004 §7.1 redact 中)。

DB-persisted audit table 留作未來 ADR / 法務需求驅動。

---

## 13. Test strategy

### 13.1 Unit(`src/**/*.test.ts`)

- TypeBox schema validation 邊界(每個 entity 的 create / patch body 各 ~6 test)
- Domain write-service 純函式邏輯(若有可純測的 — 主要是 transaction shape;mock prisma 不可用,降到 integration)
- `invalidateDonationEntity` 的 key 枚舉(以 mock-style 回傳 key list 驗證,**不**觸 Redis)
- Category key regex / spec 018 S3 key regex 已有,不重測

### 13.2 Integration(`tests/integration/`,testcontainers Postgres + Redis)

每個 entity 6 動作 × 4 ~ 6 case 各:

| Case | Charity 範例 |
|---|---|
| Happy path create | POST → 201 + Location + 完整 body + DB row 存在 + cache invalidate |
| Required field missing → 400 | POST 缺 `name` → VALIDATION_FAILED |
| Unknown categoryIds → 400 | POST `categoryIds: [<unknown uuid>]` → CHARITY_CATEGORY_INVALID |
| Happy path patch | PATCH name → 200 + updated body |
| PATCH 404 | PATCH unknown id → CHARITY_NOT_FOUND |
| PATCH replace categoryIds | 舊 join 全刪,新 join 全寫 |
| Archive — fresh row | archivedAt set + public list 不再見 |
| Archive — already archived | 200 + no cache invalidate(rowcount=0)|
| Unarchive after archive | archivedAt 變 null + public list 恢復 |
| Delete — fresh row | deletedAt set + 所有 public endpoint 不再見 |
| Restore after delete | deletedAt 變 null + 恢復 |
| Cascading invalidation | archive Charity 後,其 Project / SaleItem public list 不再含子,且**對應 cache key 不存在**(`redis.get` 為 null) |

合計約 6 entity × 12 case ≈ 60 ~ 70 integration test(扣除 Category 少 1 動作 + 細節 entity-specific variation)。

### 13.3 E2E(`tests/e2e/`,選擇性)

- `presign → PUT S3 → POST charity → GET 看到 logo URL` 完整流程一次

---

## 14. Open questions

| # | 問題 | 暫定方向 |
|---|---|---|
| 1 | ~~何時加 admin auth?用什麼 model?~~ | ✅ **v0.2 收束** — 採 const `Role.ADMIN = 0` / `USER = 1`;`Account.role` Int @default(1);JWT 攜帶 role claim。未來如需 `MODERATOR` / `SUPPORT` 細分,再升 Prisma enum |
| 2 | Hard delete / GDPR retention | 等法務需求;預計後續 ADR + admin endpoint |
| 3 | Audit DB table | 等合規需求 |
| 4 | Bulk operations(批次 archive 100 個 row) | 等實際 admin 使用情境;一次性 script 先擋 |
| 5 | Optimistic locking(If-Match) | 等 admin UI 上線 |
| 6 | S3 orphan 自動清理 | 走 S3 lifecycle policy(無 backend code 變動)+ 一次性 admin script(已有 `cleanup-orphan-charity-logos.ts` pattern) |
| 7 | Category dynamic key | spec 016 §5.1 改 runtime-validated 後可開,影響大 |
| 8 | publishStart/End vs archive 的優先級 | publish 排程觸發時不會自動 archive;若需要請手動 archive + setting publishStart |
| 9 | `Idempotency-Key` header 支援 create | 等具體 use case;目前 client retry 可能造成重複 row |
| 10 | 第一個 admin 從哪來? | bootstrap 走 prisma seed 或一次性 script;先寫進 `prisma/seed.ts` 建一筆固定 admin(email + role=0),env 提供初始密碼;真正部署時改走「**啟動時偵測 admin 不存在 → fail-loud**」的 health check |
| 11 | `/v1/donation/uploads/presign` 是否也需 ADMIN gate? | **建議是** — 只有 admin 上傳圖檔有意義;留 spec 018 補丁;本期實作時順手加 |
| 12 | OpenAPI 文件 | spec 016 §12.1 v0.13 已建立 `openapiPlugin`;新 endpoint 自動 walk + document,**不需**手動更新 |

---

## 15. 落地順序(spec → code 階段)

| Phase | 內容 | 工時估 |
|---|---|---|
| **Phase 0**:本 spec merge | review / 補洞 | — |
| **Phase 1**:基礎建設 | `domain/donation-item/write-services.ts` 樣板(僅 charity create / update 兩個)+ `invalidate-donation.ts` helper + 3 個 error code + Charity 1 整套 endpoint + tests | ~7 hr |
| **Phase 2**:Charity 其餘 4 動作 + Project + SaleItem 全套(複製樣板) | 純複製 / 微調 | ~10 hr |
| **Phase 3**:Category 5 動作 | Category 較簡單,沒有 cascading | ~3 hr |
| **Phase 4**:本 spec 補 v0.2(根據實作回饋)+ spec 016 / 017 補引用 + OpenAPI 驗證 | 收尾 | ~3 hr |

**總計約 23 小時**(與規劃階段估計一致)。

---

## 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-15 | 初版 |
| 0.2 | 2026-06-15 | §2.3 rewrite:從「無 auth」改為「JWT role 0 = ADMIN required」— 引入 `Role.ADMIN = 0` / `USER = 1` const(`src/lib/auth/role.ts`),`Account.role Int @default(1)`,JWT 攜帶 role claim,非 admin → 403。§11 rate-limit 隨之放寬(per-user + per-IP 雙層,「人類管理員實際操作上限」級別)。§14 收束 OQ #1(auth 已定),新增 OQ #10(第一個 admin bootstrap)、OQ #11(presign 是否也 gate),原 #10 改 #12。需後續更新 spec 007 §10 / §11(model + claim)與 spec 008 §4.2(register 預設 role=1)|
| 0.3 | 2026-06-16 | §1 加 spec 023 §2 URL prefix cross-ref(public read → `/user/v{N}`、admin write → `/cms`、auth → `/auth`);本 spec endpoint path 列為 surface 內相對路徑,實際 client URL 由 surface prefix 拼成。完整 URL mapping 表見 spec 023 §2.4。對應 backend code/test 已 cutover 至新結構 |
