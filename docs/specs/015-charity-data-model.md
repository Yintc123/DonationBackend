# Spec 015:捐款項目資料模型(Charity / DonationProject / SaleItem / Category)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.10 |
| 日期 | 2026-06-14 |
| 適用範圍 | `backend/prisma/schema.prisma`、`backend/prisma/seed.ts`、`backend/src/domain/donation-item/*`、`backend/src/domain/category/*` |
| 相關 ADR | `../../docs/decisions/003-database-postgresql.md`(專案級)、`../../docs/decisions/007-orm-prisma.md`(專案級)、`../decisions/001-donation-item-relations.md`(backend 級 — 三 entity 1:N NOT NULL FK)、`../decisions/002-charity-category-model.md`(backend 級 — Charity-Category M:N + 子表繼承)、`../decisions/004-i18n-storage-model.md`(backend 級 — 多語系 suffix columns 設計)、`../decisions/006-lifecycle-fields-and-cascading-visibility.md`(backend 級 — soft delete / archive / 上下架時間 / cascading visibility,**v0.9 起 schema 加 5 欄**)|
| 相關 spec | `003-orm-module.md`(Prisma client 與命名)、`016-charity-list-api.md`(本資料模型的對外 contract)、`018-storage-module.md`(v0.8 起圖片欄位存 S3 key,API 層建 URL)|
| 設計來源 | Figma《2026 全端面試作業 - web》file key `0kx2Ne2rvndhfVr3uVUwad`,頁面標題「所有捐款項目」;Category 模型補 Figma 缺圖(2026-06-14 產品口頭確認)|

---

## 1. 目的與範圍

### 1.1 目的

定義 backend 對「捐款項目」這個 umbrella concept 下的持久化模型:

- **Charity(公益團體)** / **DonationProject(捐款專案)** / **SaleItem(義賣商品)** — 對應 Figma 三個 tab
- **Category(分類)** / **CharityOnCategory** — 對應「全部」filter dropdown 的選項與多對多關聯
- **多語系**(zh-TW 主語 + en 翻譯)— 以 suffix columns(`name` / `nameEn`)儲存於各 entity

### 1.2 In scope

- 五個 model 的欄位、型別、約束、索引
- 三 entity 之間的關聯(Project / SaleItem `belongs to` Charity)
- Charity ↔ Category 的 M:N 關聯
- DonationProject / SaleItem 透過主表的分類繼承(filter 時 JOIN)
- 搜尋欄位的索引策略(`pg_trgm`)
- Seed 資料注入策略(對應作業加分項「建立 Database」)
- 命名規約(snake_case in DB / camelCase in Prisma)
- **Entity lifecycle 欄位**(v0.9 — ADR 006):`displayOrder` / `archivedAt` / `deletedAt` / `publishStartAt` / `publishEndAt`,涵蓋手動排序、暫時下架、soft delete、排程上架 / 下架(合作合約期限)
- **Cascading visibility**(v0.9 — ADR 006 §3):DonationProject / SaleItem 公開可見性必須同時通過自己**與**主辦 Charity 的 lifecycle filter

### 1.3 Out of scope

- **API 行為**(分頁、查詢參數、回應 shape)— 由 spec 016 擁有(本 spec 只規範 schema + 預設 query helper 命名,filter 套用點由 spec 016 / 017 落實)
- **使用者收藏 / 追蹤** — 不在本次作業需求
- **金流、捐款交易、訂單、收據** — 不在本次作業需求,但 model 命名需避免日後衝突(見 §10)
- **Admin endpoint** — 後台 UI 不在本作業 scope;本 spec 只**約定** admin 路徑必須繞過預設 `whereLive` 走 `whereForAdmin`(細節見 ADR 006 §5)
- ~~**soft delete / audit log**~~ → v0.9 已收束,改由 ADR 006 規範 `deletedAt` timestamp 同時擔任 soft-delete 與最小 audit 角色;若日後需 actor 維度 audit,ADR 006 升級觸發已列出路徑

---

## 2. 設計原則

1. **三個 entity 共用同一張「卡片視覺」結構**(經產品確認):logo + 名稱 + 簡介。各 model 欄位 shape **一致**(僅 namespace / FK 不同),不引入類型專屬欄位(目標金額、價格、庫存…)。Figma 未提供這類欄位,主動加 = 過度設計。
2. **3 張獨立表,不走 STI / 多型欄位**(經產品確認):
   - 各自獨立的 model + table + Prisma client 出口,型別最乾淨
   - API 端各自獨立 endpoint,query / response shape 一樣(spec 016 用 generic 抽 schema,避免三套 boilerplate)
3. **Project / SaleItem `belongs to` Charity**(ADR `001-donation-item-relations.md` 定錨):
   - 語意:每個募款專案 / 義賣商品都必有主辦團體(否則募到的錢 / 營收歸誰?)
   - FK `charityId` **NOT NULL**;`onDelete: Restrict`
4. **Charity ↔ Category 採 M:N**(ADR `002-charity-category-model.md` 定錨):
   - 公益團體跨領域是常態(慈濟同時做醫療 / 救難 / 教育),M:N 才不損失資訊
   - `Category` 為一級實體,有 `key` / `displayName` / `displayOrder` 等 metadata
   - **DonationProject / SaleItem 不自存分類**,filter 時 JOIN 主辦團體的 categories(子表繼承)— 避免資料重複與不一致
5. **欄位語意對齊 ADR 003**:`uuid` 主鍵、`createdAt`/`updatedAt` 必有、字串長度有上限、可選欄位明確標記
6. **搜尋為一級需求**:作業要求三 tab 各自關鍵字搜尋,三表都建 trigram 索引(含中英文各一組)
7. **多語系採 suffix columns**(backend ADR 004 定錨):中文主語 NOT NULL、英文 nullable;API 層用 `Accept-Language` 選欄位,response shape 對 client 不變(`name: string`,英文缺則 fallback 主語)
8. **Entity lifecycle 統一模式**(v0.9 — backend ADR 006 定錨):三主 entity(Charity / Project / SaleItem)各加 5 個欄位 `displayOrder` / `archivedAt` / `deletedAt` / `publishStartAt` / `publishEndAt`;**timestamp 而非 boolean**(deletedAt 同時擔任 soft-delete marker + 最小 audit);Category 只加 `archivedAt` / `deletedAt`(字典表無合作期限);CharityOnCategory join 表**不**加 lifecycle 欄位(直接刪 join 列等於 unassign)
9. **Cascading visibility**(v0.9 — backend ADR 006 §3 定錨):Project / SaleItem 公開路徑 query 必須 JOIN `charities` 並對 parent 同套 `whereLive`;Charity 合約過期 → 旗下所有子表自動消失;續約 → 自動恢復;**禁止**用 batch job 同步狀態(避免續約時 cascade 倒回的複雜度)

---

## 3. Prisma Models

```prisma
// Spec 015 — 捐款項目(donation items)+ 分類
//
// 結構:
//   Charity (主表) 1 ── N DonationProject  (子表,FK charityId, Restrict)
//                  1 ── N SaleItem         (子表,FK charityId, Restrict)
//                  M ── N Category         (透過 CharityOnCategory join)
//
// DonationProject / SaleItem 不自存分類,filter 時 JOIN charity_categories。

model Charity {
  id              String   @id @default(uuid())
  // 多語系欄位(v0.7 — ADR 004 suffix columns)
  name            String   @db.VarChar(120)        // zh-TW 主語,NOT NULL
  description     String   @db.VarChar(500)        // zh-TW
  nameEn          String?  @db.VarChar(120)        // en,缺則 API fallback 主語
  descriptionEn   String?  @db.VarChar(500)        // en
  logoKey         String?  @db.VarChar(512)        // v0.8 — S3 key,API 層用 objectUrl() 建 URL
  // v0.6 補件揭露(IMG_4876)
  contactPhone    String?  @db.VarChar(40)        // 「02-66040024」
  contactEmail    String?  @db.VarChar(254)       // RFC 5321 上限
  officialWebsite String?  @db.VarChar(2048)
  approvalNo      String?  @db.VarChar(80)        // 核准字號「台內團字第1110295700號」
  // Lifecycle 欄位(v0.9 — ADR 006)
  displayOrder    Int      @default(0)             // 排序;0 = 一般,負數 / 較小先顯示
  archivedAt      DateTime?                        // 暫時下架(可恢復);非空 = 已封存
  deletedAt       DateTime?                        // soft delete + 最小 audit;非空 = 已刪除
  publishStartAt  DateTime?                        // 合約 / 平台合作起始;null = 立刻上架
  publishEndAt    DateTime?                        // 合約 / 平台合作結束;null = 永久(直到手動下架)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  donationProjects DonationProject[]
  saleItems        SaleItem[]
  categories       CharityOnCategory[]

  // v0.9 — ADR 006:public list 主路徑為 whereLive(deleted/archived/publish 全通過),
  // 用 displayOrder + createdAt + id 排序。partial index 把這條 query 壓縮到 index-only scan。
  @@index([displayOrder, createdAt(sort: Desc), id(sort: Desc)])
  @@index([publishEndAt])                          // cascade visibility 查 parent 過期
  @@index([createdAt(sort: Desc), id(sort: Desc)]) // admin 全量(允許看 archived / deleted)
  @@map("charities")
}

model DonationProject {
  id                  String   @id @default(uuid())
  charityId           String
  // 多語系欄位(v0.7)
  name                String   @db.VarChar(120)    // zh-TW
  description         String   @db.VarChar(500)    // zh-TW
  nameEn              String?  @db.VarChar(120)    // en
  descriptionEn       String?  @db.VarChar(500)    // en
  logoKey             String?  @db.VarChar(512)    // v0.8 — S3 key
  // v0.6 補件揭露(IMG_4880 / IMG_4883)
  coverImageKey       String?  @db.VarChar(512)    // v0.8 — S3 key,列表頁 + 詳情頁主視覺
  content             String   @db.Text            // 完整專案內容,zh-TW
  contentEn           String?  @db.Text            // en
  raisingApprovalNo   String?  @db.VarChar(80)     // 勸募立案核准字號
  reliefApprovalNo    String?  @db.VarChar(80)     // 衛部救字第1151361613號 等
  // Lifecycle 欄位(v0.9 — ADR 006)
  displayOrder        Int      @default(0)         // 排序
  archivedAt          DateTime?                    // 暫時下架
  deletedAt           DateTime?                    // soft delete
  publishStartAt      DateTime?                    // 募款開始;null = 立刻
  publishEndAt        DateTime?                    // 募款結束;null = 永久(直到手動)
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  charity Charity @relation(fields: [charityId], references: [id], onDelete: Restrict)

  @@index([charityId])
  @@index([charityId, displayOrder, createdAt(sort: Desc), id(sort: Desc)]) // v0.9 — public list (whereLive 主路徑)
  @@index([publishEndAt])                                                    // 排程下架 sweep / 過期 query
  @@index([createdAt(sort: Desc), id(sort: Desc)])                          // admin 全量
  @@map("donation_projects")
}

model SaleItem {
  id                  String   @id @default(uuid())
  charityId           String
  // 多語系欄位(v0.7)
  name                String   @db.VarChar(120)    // zh-TW
  description         String   @db.VarChar(500)    // zh-TW
  nameEn              String?  @db.VarChar(120)    // en
  descriptionEn       String?  @db.VarChar(500)    // en
  logoKey             String?  @db.VarChar(512)    // v0.8 — S3 key
  // v0.6 補件揭露(IMG_4877 / IMG_4882)
  coverImageKey       String?  @db.VarChar(512)    // v0.8 — S3 key
  priceTwd            Int                          // TWD 整數(IMG_4877 顯示 1,000 / 1,330 等);NOT NULL
  content             String   @db.Text            // 商品說明,zh-TW
  contentEn           String?  @db.Text            // en
  raisingApprovalNo   String?  @db.VarChar(80)     // 勸募立案核准字號
  reliefApprovalNo    String?  @db.VarChar(80)     // 衛部救字第1141364521號 等
  // Lifecycle 欄位(v0.9 — ADR 006)
  displayOrder        Int      @default(0)         // 排序
  archivedAt          DateTime?                    // 暫時下架
  deletedAt           DateTime?                    // soft delete
  publishStartAt      DateTime?                    // 開賣時間;null = 立刻
  publishEndAt        DateTime?                    // 下架時間;null = 永久(直到手動)
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  charity Charity @relation(fields: [charityId], references: [id], onDelete: Restrict)

  @@index([charityId])
  @@index([charityId, displayOrder, createdAt(sort: Desc), id(sort: Desc)]) // v0.9 — public list (whereLive 主路徑)
  @@index([publishEndAt])                                                    // 排程下架 sweep / 過期 query
  @@index([createdAt(sort: Desc), id(sort: Desc)])                          // admin 全量
  @@map("sale_items")
}

// 分類字典表
model Category {
  id             String   @id @default(uuid())
  key            String   @unique @db.VarChar(40)    // 程式用識別,如 "animal_protection"
  displayName    String   @db.VarChar(80)             // UI 顯示,zh-TW,如 "動物保護"
  displayNameEn  String?  @db.VarChar(80)             // en,如 "Animal Protection"
  displayOrder   Int      @default(0)                 // dropdown 排序
  // Lifecycle 欄位(v0.9 — ADR 006;字典表沒有合作期限,因此不加 publishStartAt / publishEndAt)
  archivedAt     DateTime?                            // 暫時隱藏該分類
  deletedAt      DateTime?                            // soft delete + 最小 audit
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  charities CharityOnCategory[]

  @@index([displayOrder])
  @@map("categories")
}

// Charity ↔ Category 的 M:N join 表
model CharityOnCategory {
  charityId  String
  categoryId String
  assignedAt DateTime @default(now())

  charity  Charity  @relation(fields: [charityId],  references: [id], onDelete: Cascade)
  category Category @relation(fields: [categoryId], references: [id], onDelete: Restrict)

  @@id([charityId, categoryId])
  @@index([categoryId])       // 反向查「該分類下所有團體」
  @@map("charity_categories")
}
```

### 3.1 三 entity 共用欄位字典(Charity / DonationProject / SaleItem)

| 欄位 | 型別 | Null | 長度 / 規則 | 說明 |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | — | 主鍵,Prisma `@default(uuid())` |
| `name` | `varchar(120)` | NOT NULL | trim 後 1 ~ 120 字 | 卡片標題(**zh-TW 主語**)|
| `description` | `varchar(500)` | NOT NULL | trim 後 1 ~ 500 字 | 卡片簡介,純文字(**zh-TW**)|
| `nameEn` | `varchar(120)` | NULL | trim 後 1 ~ 120 字 | 英文翻譯;缺則 API fallback 至 `name`(v0.7 — ADR 004)|
| `descriptionEn` | `varchar(500)` | NULL | trim 後 1 ~ 500 字 | 英文翻譯;缺則 fallback 至 `description` |
| `logoKey` | `varchar(512)` | NULL | S3 key,符合 spec 018 §5.1 pattern(`donation/{entity}/{id}/{purpose}.{ext}`)| 列表頁小 logo;Charity 卡用主視覺,Project / SaleItem 卡用 `coverImageKey`。**API 層用 `objectUrl(logoKey)` 拼最終 URL,DB 不存完整 URL**(v0.8 — env 解耦、CDN 切換 config-only;見 backend spec 018 §1.1)|
| `displayOrder` | `int` | NOT NULL | 預設 `0`;application 層允許負數 | 手動排序;0 = 一般,**負數 / 較小先顯示**;list `ORDER BY display_order ASC, created_at DESC, id DESC`(v0.9 — ADR 006)|
| `archivedAt` | `timestamptz` | NULL | — | 暫時下架(可恢復);**非空時 public list / detail 不可見**;預設 list query 必須加 `archivedAt IS NULL`(v0.9 — ADR 006)|
| `deletedAt` | `timestamptz` | NULL | — | soft delete(預期不恢復,合規 / audit 用);**非空時所有 endpoint 不可見**;預設 list query 必須加 `deletedAt IS NULL`;timestamp 同時擔任最小 audit(誰刪可由 application log 補)(v0.9 — ADR 006 §1)|
| `publishStartAt` | `timestamptz` | NULL | — | 排程上架時間;`null` = 立刻上架;public list query 加 `(publishStartAt IS NULL OR publishStartAt <= NOW())`(v0.9 — ADR 006)|
| `publishEndAt` | `timestamptz` | NULL | — | 排程下架時間;`null` = 永久上架(直到手動);public list query 加 `(publishEndAt IS NULL OR publishEndAt > NOW())`;**Charity 的 publishEndAt = 合作合約結束日**;public list 中 Project / SaleItem **同時**要求 parent Charity 的 publishEndAt 通過(cascading visibility — ADR 006 §3)|
| `createdAt` | `timestamptz` | NOT NULL | `now()` | cursor 分頁次要排序 / tiebreaker(v0.9 起預設排序的 secondary key,首要是 `displayOrder`)|
| `updatedAt` | `timestamptz` | NOT NULL | `@updatedAt` | ETag 計算(spec 009 §8.3) |

> **注意**:v0.4 的 `category String?` 欄位**已移除**,改由 Category M:N 關聯處理(§3.3)。
> **v0.7 i18n 政策**:主語(zh-TW)NOT NULL、翻譯(en)nullable。API 層用 `Accept-Language` 選欄位,response shape 對 client 不變(統一回 `name: string`,英文缺則 fallback)。詳見 backend ADR 004。

### 3.2 各 model 額外欄位(v0.6 補件揭露)

**Charity 額外欄位**(IMG_4876 公益團體介紹頁):

| 欄位 | 型別 | Null | 長度 / 規則 | 說明 |
|---|---|---|---|---|
| `contactPhone` | `varchar(40)` | NULL | 國際格式 / 含「-」「空格」均接受 | 「02-66040024」 |
| `contactEmail` | `varchar(254)` | NULL | RFC 5321;application 層 email regex | 「serv.accofroc@gmail.com」 |
| `officialWebsite` | `varchar(2048)` | NULL | absolute URL,`http(s)` | 「https://accofroc.org」 |
| `approvalNo` | `varchar(80)` | NULL | 純字串,application 層不規範格式 | 「台內團字第1110295700號」 |

> 這些欄位 **不需多語系**:電話 / email / URL 語系無關;核准字號是政府發的中文編號,英文版頂多轉拼音、不算翻譯(ADR 004 §決策)。

**DonationProject 額外欄位**(IMG_4880 列表 + IMG_4883 詳情):

| 欄位 | 型別 | Null | 長度 / 規則 | 說明 |
|---|---|---|---|---|
| `charityId` | `uuid` | NOT NULL | FK → `charities.id`,`onDelete: Restrict` | 主辦團體 |
| `coverImageKey` | `varchar(512)` | NULL | S3 key,符合 spec 018 §5.1 pattern | 列表卡 + 詳情頁主視覺;API 層 `objectUrl(coverImageKey)` 拼 URL(v0.8)|
| `content` | `text` | NOT NULL | trim 後 ≥ 1 字,無上限(text) | 完整專案內容,詳情頁顯示 |
| `raisingApprovalNo` | `varchar(80)` | NULL | 純字串 | 勸募立案核准字號 |
| `reliefApprovalNo` | `varchar(80)` | NULL | 純字串 | 「衛部救字第1151361613號」 |

**SaleItem 額外欄位**(IMG_4877 列表 + IMG_4882 詳情):

| 欄位 | 型別 | Null | 長度 / 規則 | 說明 |
|---|---|---|---|---|
| `charityId` | `uuid` | NOT NULL | FK → `charities.id`,`onDelete: Restrict` | 主辦團體 |
| `coverImageKey` | `varchar(512)` | NULL | S3 key,符合 spec 018 §5.1 pattern | 列表 + 詳情頁主視覺(也作為「公益義賣 SHOP FOR CHANGE」絲帶 banner 底圖);API 層 `objectUrl(coverImageKey)` 拼 URL(v0.8)|
| `priceTwd` | `int` | **NOT NULL** | `≥ 0` | TWD 整數,無小數 |
| `content` | `text` | NOT NULL | trim 後 ≥ 1 字 | 商品說明,詳情頁顯示 |
| `raisingApprovalNo` | `varchar(80)` | NULL | 純字串 | 勸募立案核准字號 |
| `reliefApprovalNo` | `varchar(80)` | NULL | 純字串 | 「衛部救字第1141364521號」 |

> 「核准字號」/「衛部救字號」截圖示意為人類可讀字串,不做結構化解析;application 層長度檢查即可。日後若需驗證格式可加 regex。
>
> SaleItem 的 `priceTwd` NOT NULL:截圖顯示每件義賣商品必有定價,業務語意要求。預設值不設,seed / API 寫入時強制。

### 3.3 Category 與 CharityOnCategory

**`Category` 欄位字典:**

| 欄位 | 型別 | Null | 長度 / 規則 | 說明 |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | — | 主鍵 |
| `key` | `varchar(40)` | NOT NULL | unique;`[a-z][a-z_]*`;1 ~ 40 字 | 程式用識別碼,如 `animal_protection` |
| `displayName` | `varchar(80)` | NOT NULL | 1 ~ 80 字 | UI 顯示文字,如 `流浪動物` |
| `displayNameEn` | `varchar(80)` | NULL | 1 ~ 80 字 | en;dropdown 對英文 client 顯示;v0.7 起 16 筆 seed 100% backfill |
| `displayOrder` | `int` | NOT NULL | 預設 `0` | dropdown 排序;同值依 `key` 字典序 |
| `archivedAt` | `timestamptz` | NULL | — | 暫時隱藏分類(可恢復);v0.9 — ADR 006;預設 list 加 `archivedAt IS NULL`;**非空時不出現在 `/v1/donation/categories` dropdown,但既有 join 列保留**(已掛到該分類的 Charity 不受影響) |
| `deletedAt` | `timestamptz` | NULL | — | soft delete 字典項;v0.9 — ADR 006;非空時所有 endpoint 不可見;**FK Restrict 仍然會擋 hard delete**(spec §3.5) |
| `createdAt` | `timestamptz` | NOT NULL | `now()` | |
| `updatedAt` | `timestamptz` | NOT NULL | `@updatedAt` | |

> Category **不**加 `publishStartAt` / `publishEndAt`:字典表是平台內部運營項目,無「合作合約期限」概念。需要暫時隱藏用 `archivedAt`(ADR 006 §1 / §決策 4)。

**`CharityOnCategory` 欄位字典:**

| 欄位 | 型別 | Null | 規則 | 說明 |
|---|---|---|---|---|
| `charityId` | `uuid` | NOT NULL | FK → `charities.id`,`onDelete: Cascade` | 刪 Charity 時 join 列自動清掉 |
| `categoryId` | `uuid` | NOT NULL | FK → `categories.id`,`onDelete: Restrict` | 刪 Category 時若有團體用 → 擋下 |
| `assignedAt` | `timestamptz` | NOT NULL | `now()` | 指派時間,debugging / audit 用 |
| 主鍵 | composite `(charityId, categoryId)` | | | 同一團體不能掛同一分類兩次 |

### 3.3 約束(共同)

- `name` / `description` 在 application 層用 TypeBox 做 trim + 長度檢查(spec 016 route schema 內處理);DB 層僅 `varchar(N)` 攔極端值
- `logoKey` / `coverImageKey` 若有值必符合 spec 018 §5.1 pattern(`^donation/(charities|donation-projects|sale-items)/[0-9a-f-]{36}/(logo|cover)\.(png|jpg|jpeg|webp|gif)$`),application 層 regex 驗證,DB 層長度限制
- 不設 unique constraint:同名項目允許(分會、不同期專案、批次商品),由 `id` 唯一識別
- 不設 enum on `category`:理由見 §7

#### v0.9 — Lifecycle 約束(ADR 006)

- **`publishStartAt` ≤ `publishEndAt`**:application 層在 write 時檢查;DB 層不加 CHECK constraint(避免 NULL 處理糾結)
- **`archivedAt` 與 `deletedAt` 正交**:可以同時存在(先 archive、後 delete);query filter 用 OR 不是 AND
- **預設 list filter 強制四條件**:所有公開 list / detail endpoint 必須通過 `whereLive`(`deletedAt IS NULL AND archivedAt IS NULL AND publishStartAt 在過去 AND publishEndAt 在未來`);**route handler 禁止自拼 where**,必須走 service-layer helper(ADR 006 §2)
- **Cascading visibility**:DonationProject / SaleItem 的公開 query 必須 JOIN charities 並對 parent 再套 `whereLive`(ADR 006 §3);Charity 自身 list 不需 cascade(它是最上層)
- **預設排序**:`ORDER BY display_order ASC, created_at DESC, id DESC`(三 entity 共用,ADR 006 §4)

### 3.4 為何 Project / SaleItem 的 `onDelete: Restrict`

| 規則 | 行為 | 適不適合本場景 |
|---|---|---|
| `Cascade` | 刪 Charity → 連帶刪所有 Project / SaleItem | ❌ Charity 被誤刪時連帶吞掉歷史專案,**不可逆 hard delete** |
| **`Restrict`** | 刪 Charity 前必須先把所有 Project / SaleItem 處理掉(soft delete 或物理刪除) | ✅ 防誤刪;與 v0.9 soft delete 模型協作 |
| `SetNull` | FK 變 null | ❌ 違反 §2 NOT NULL 約定 |

> **v0.9 變更**:soft delete(set `deletedAt`)是業務預設動作,**不**觸發 onDelete cascade(`deletedAt` 只是欄位 update,不是 DELETE)。Cascading visibility(Project / SaleItem 隨 Charity 一起從 public 消失)由 query-layer JOIN filter 實現(ADR 006 §3),**不**由 DB FK cascade 實現 — 兩者目的不同:FK cascade 處理 hard delete 的 referential integrity,query JOIN 處理 public 可見性。`Restrict` 在 hard delete 路徑仍是正解。

### 3.5 為何 CharityOnCategory 兩端的 cascade 不對稱

| FK | onDelete | 理由 |
|---|---|---|
| `CharityOnCategory.charityId` → `charities` | **Cascade** | join 列是 symbolic 關聯,不是業務資料。刪 Charity 時相應 join 列無存在意義,自動清掉 |
| `CharityOnCategory.categoryId` → `categories` | **Restrict** | Category 是字典,被使用中不能直接刪,強制管理員先解除掛載(或評估改 soft delete) |

對稱性與業務語意不同方向,刻意如此 — Charity 是主表,Category 是字典表。

---

## 4. 索引策略

### 4.1 已宣告的索引(每張表)

| 索引 | 用途 | 覆蓋查詢 |
|---|---|---|
| 主鍵 `(id)` | resource 查詢 | `WHERE id = ?` |
| **`(displayOrder, createdAt DESC, id DESC)`**(v0.9 — Charity)| public list 主路徑 + cursor 分頁 tiebreaker | `ORDER BY display_order ASC, created_at DESC, id DESC LIMIT ?` |
| **`(charityId, displayOrder, createdAt DESC, id DESC)`**(v0.9 — Project / SaleItem)| 「某團體底下所有專案 / 商品」+ public list 排序合一(spec 016 §4.5 + ADR 006 §4)| `WHERE charity_id = ? ORDER BY display_order ASC, created_at DESC, id DESC` |
| `(createdAt DESC, id DESC)`(v0.9 起退居 admin 全量查詢)| admin endpoint 允許看 archived / deleted 的全量列表 | `ORDER BY created_at DESC, id DESC LIMIT ?` |
| **`(publishEndAt)`**(v0.9 — 三主 entity)| 排程下架 sweep + 「即將過期」query | `WHERE publish_end_at < NOW() + interval '7 days'` |
| `(charityId)`(Project / SaleItem,**v0.9 起為 redundant** 但保留)| 簡單 FK lookup,Prisma `include` 也用 | `WHERE charity_id = ?` |
| `categories.(displayOrder)` | dropdown 排序 | `ORDER BY display_order, key` |
| `categories.(key)` | unique constraint + key lookup | `WHERE key = ?` |
| `charity_categories.(charityId, categoryId)` | composite PK,正向查「該團體有哪些分類」 | `WHERE charity_id = ?` |
| `charity_categories.(categoryId)` | 反向查「該分類下有哪些團體」(Charity tab filter 主路徑、Project/SaleItem tab filter 的 JOIN 起點)| `WHERE category_id = ?` |

### 4.1.1 Partial index 選項(v0.9 — ADR 006 §後果)

預設不建,**等 EXPLAIN 顯示 lifecycle filter 是熱點再加**(YAGNI):

```sql
-- 加速 public list 主路徑(whereLive 篩掉 archived/deleted 後再排序)
CREATE INDEX charities_live_idx
  ON charities (display_order ASC, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND archived_at IS NULL;

-- 同模式 donation_projects_live_idx / sale_items_live_idx(各帶 charity_id 前綴)
```

實測 trigger:`EXPLAIN ANALYZE` 顯示 sequential filter 佔比 > 30%,或單筆 query > 50ms。本作業資料量 < 1k row,**不會觸發**。

### 4.2 搜尋索引:`pg_trgm`

三張表都需要關鍵字搜尋。使用 PostgreSQL `pg_trgm` 擴充 + GIN 索引(spec 003 已預設此擴充存在)。

**Migration 追加 SQL**(Prisma DSL 無法表達):

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- charities(zh-TW)
CREATE INDEX IF NOT EXISTS charities_name_trgm_idx
  ON charities USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS charities_description_trgm_idx
  ON charities USING gin (description gin_trgm_ops);

-- charities(en — v0.7)
CREATE INDEX IF NOT EXISTS charities_name_en_trgm_idx
  ON charities USING gin (name_en gin_trgm_ops);
CREATE INDEX IF NOT EXISTS charities_description_en_trgm_idx
  ON charities USING gin (description_en gin_trgm_ops);

-- donation_projects(zh-TW)
CREATE INDEX IF NOT EXISTS donation_projects_name_trgm_idx
  ON donation_projects USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS donation_projects_description_trgm_idx
  ON donation_projects USING gin (description gin_trgm_ops);

-- donation_projects(en — v0.7)
CREATE INDEX IF NOT EXISTS donation_projects_name_en_trgm_idx
  ON donation_projects USING gin (name_en gin_trgm_ops);
CREATE INDEX IF NOT EXISTS donation_projects_description_en_trgm_idx
  ON donation_projects USING gin (description_en gin_trgm_ops);

-- sale_items(zh-TW)
CREATE INDEX IF NOT EXISTS sale_items_name_trgm_idx
  ON sale_items USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sale_items_description_trgm_idx
  ON sale_items USING gin (description gin_trgm_ops);

-- sale_items(en — v0.7)
CREATE INDEX IF NOT EXISTS sale_items_name_en_trgm_idx
  ON sale_items USING gin (name_en gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sale_items_description_en_trgm_idx
  ON sale_items USING gin (description_en gin_trgm_ops);
```

> **GIN 對 NULL 行為**:PG GIN index 預設不索引 NULL 值。沒英文翻譯的列在 `WHERE name_en ILIKE '...'` 自然不命中,**符合 locale-specific 搜尋語意**(英文 client 找英文欄位,fallback 是 response 層的事,不污染搜尋結果)。`content` 欄位為長文,**不**建 trgm index(spec 016 §4.6 已說明 content 不參與全文搜尋)。

> Migration 流程:`prisma migrate dev --create-only --name add_donation_items` → 在 SQL 末尾追加上述 → 再執行。

### 4.3 為何不用 `tsvector`

(與 v0.1 相同 — `pg_trgm` 對中英混雜短字串夠用,`tsvector + zhparser` 跨環境部署成本高,本作業 ROI 差。資料量超過 10 萬筆時再換。)

---

## 5. ER 圖

```
   ┌───────────────────┐                  ┌────────────────────┐
   │     Category      │                  │      Charity       │  ← 主表
   │                   │                  │                    │
   │ id (PK)           │                  │ id (PK)            │
   │ key (unique)      │  M ┌───────┐ N   │ name               │
   │ displayName       │◄───┤ Charity├───►│ description        │
   │ displayOrder      │    │ OnCat. │    │ logoKey?           │
   │ createdAt         │    │  join  │    │ createdAt          │
   │ updatedAt         │    └───────┘     │ updatedAt          │
   └───────────────────┘                  └────────┬───────────┘
                                                   │ 1
                                        ┌──────────┴──────────┐
                                        │                     │
                                        │ N                   │ N
                               ┌────────▼──────────┐ ┌────────▼──────────┐
                               │ DonationProject   │ │     SaleItem      │  ← 子表
                               │                   │ │                   │
                               │ id (PK)           │ │ id (PK)           │
                               │ charityId (FK)    │ │ charityId (FK)    │  ← NOT NULL
                               │ name              │ │ name              │
                               │ description       │ │ description       │
                               │ logoKey?          │ │ logoKey?          │
                               │ createdAt         │ │ createdAt         │
                               │ updatedAt         │ │ updatedAt         │
                               └───────────────────┘ └───────────────────┘
```

關聯:
- **Charity 1 ─ N DonationProject** / **Charity 1 ─ N SaleItem** — FK NOT NULL,`onDelete: Restrict`
- **Charity M ─ N Category**(透過 `CharityOnCategory` join) — Charity 端 Cascade,Category 端 Restrict(§3.5)
- DonationProject / SaleItem **無 category** 欄位,filter 時 JOIN `charity_categories` 取得主辦團體的分類(子表繼承)

> **v0.9 — Lifecycle 欄位未列圖**(篇幅):三主 entity(Charity / Project / SaleItem)各有 `displayOrder` + `archivedAt` + `deletedAt` + `publishStartAt` + `publishEndAt`,Category 有 `archivedAt` + `deletedAt`。public list / detail query 必須通過 `whereLive` 四條件;Project / SaleItem 額外 cascade 通過 parent Charity 的 `whereLive`(ADR 006 §2 / §3)。

---

## 6. Seed / Mock 資料

### 6.1 策略

呼應作業加分項「建立 Database,存放設計好的 Mock Data」與 backend `CLAUDE.md` 「不 mock DB」原則:**三張表的 Mock 都以 seed 形式落 PostgreSQL**。

### 6.2 來源與量級

| Entity | 量級 | 名稱來源 |
|---|---|---|
| `Category` | **固定 16 筆**(v0.6) | 對齊 IMG_4879 / 4881(見 §7.1) |
| `Charity` | ≥ 20 筆 | IMG_4876 範例「ACC 中華耆幼關懷協會」+ 補造;聯絡欄位 / 核准字號可半真半造 |
| `CharityOnCategory` | 視 Charity 數量 | 每個 Charity 隨機指派 **1 ~ 3 個 Category**(`animal_protection` / `child_care` 等熱門類別至少 2 個團體掛上,供 demo filter 命中)|
| `DonationProject` | ≥ 30 筆 | IMG_4883 範例「【安居・專業・愛】守護身障弱勢…」+ 補造;FK 平均分佈,每個 Charity **至少 1 個專案**;`content` 用 lorem 或範例文 + 至少 1 筆含「衛部救字第」格式字串 |
| `SaleItem` | ≥ 30 筆 | IMG_4877 / IMG_4882 範例「北歐天然 小型寵物魚油 2oz」+ 補造;每件 `priceTwd` 在 100 ~ 5000 區間;FK 平均分佈,每個 Charity **至少 1 個商品** |

### 6.3 檔案位置

```
backend/prisma/
├── seed.ts                          # 入口(依序呼叫子 seeder)
└── seed/
    ├── categories.ts                # 16 筆固定資料(對齊 §7.1)
    ├── charities.ts                 # 含 categories assignment
    ├── donation-projects.ts
    └── sale-items.ts
```

`package.json` 加:

```jsonc
{
  "prisma": { "seed": "tsx prisma/seed.ts" }
}
```

執行:`npx prisma db seed`。

### 6.4 Seed 內容約束

- `id` **不**寫死 — 由 `uuid` 預設值產生
- `logoKey` / `coverImageKey` 可空;若有值,**seed script 自己直接用 AWS SDK 把 placeholder 圖檔 putObject 到 LocalStack bucket**,再用 Prisma 把對應 key 寫進 DB。**不**經 backend HTTP(seed.ts 是獨立 Node 程序,與 runtime presign 上傳流程無關 — runtime 才走 §spec 018 §7 的 frontend → signed URL → S3 路徑)。Bootstrap 細節見 spec 018 §9.3
- **v0.10 — Charity logo featured-only 策略**:30 個 complete charity 中**只有 1 筆**(slug `taiwan-stray-animal` / 名稱「台灣流浪動物之家基金會」)`logoKey` 非 null,圖檔來源 `prisma/assets/charity-placeholder.png`(從 `frontend/public/figma/charity-placeholder.png` 複製,~165 KB)。其餘 29 個 charity `logoKey = null`,frontend 走預設 avatar 渲染。理由:1×1 透明 placeholder 在 UI 上跟「沒圖」表現一樣,徒增 S3 / cache / bandwidth 成本;改成「精選一張真實圖 + 其餘走 default」更如實還原 demo 體感。Project / SaleItem 的 cover 仍走 1×1 placeholder(未來再考慮 featured-only)。`seed.ts` post-condition 同步調整:`completeCharities` 8 欄位(去掉 `logoKey`),新增 `charitiesWithRealLogo === slugLogos.size` 嚴格檢查。歷史 1×1 placeholder 的 prod S3 orphan 清理走 `backend/scripts/cleanup-orphan-charity-logos.ts`(一次性,需 admin creds — backend ECS execution role 無 `s3:DeleteObject`,符合 spec 018 §5 least privilege)
- 至少 1 個 Charity 帶齊聯絡欄位(對應 IMG_4876 範例);其他可缺一兩個欄位以測試 detail 頁 conditional render
- DonationProject / SaleItem 至少各 1 筆帶齊 `raisingApprovalNo` + `reliefApprovalNo`(IMG_4882 / 4883 範例),其他可只帶 1 個或全空
- SaleItem `priceTwd` 多樣化(100 / 920 / 1170 / 1330 / 5000 等),避免畫面全部同值
- 種子腳本 **idempotent**:刪除順序 `SaleItem` → `DonationProject` → `CharityOnCategory` → `Charity` → `Category`(對應 FK 限制);建立順序相反
- 至少 1 筆**每張表**的名稱含「流浪動物」(對應 Figma demo query 在三 tab 皆能展示搜尋命中)
- 至少 2 個 Charity 掛 `animal_protection` Category,供搜尋 + filter 組合測試(Project / SaleItem 對應的子表 filter 透過繼承自動命中)
- **v0.7 多語系 seed**:
  - 中文(`name` / `description` / `content` / `displayName`)**全筆必填**
  - 英文(`nameEn` / `descriptionEn` / `contentEn`)**至少 30%** 有 backfill(供英文 client demo 不全空;餘留 70% nullable 以測 fallback)
  - 至少 1 筆每張表的 `nameEn` 或 `descriptionEn` 含 `stray` 或 `animal`(讓「流浪動物」demo query 的英文版 `q=stray` 也命中)
  - **Category 16 筆全部**有 `displayNameEn`(dropdown 對英文 client 不可缺項)
- **v0.9 Lifecycle seed**(ADR 006):
  - 預設 **85%** row `archivedAt = null` / `deletedAt = null` / `publishStartAt = null` / `publishEndAt = null`(預設「立刻且永久上架」狀態)
  - **1 ~ 2 筆每張表**設 `archivedAt = <過去時間>` 模擬「已封存」(demo public list 不應出現)
  - **1 筆每張表**設 `deletedAt = <過去時間>` 模擬「已軟刪」(demo 所有 endpoint 不應出現)
  - **DonationProject** 至少:1 筆 `publishStartAt` 在未來(預售中)、1 筆 `publishEndAt` 已過期(募款結束)、1 筆 `publishStartAt` 在過去 + `publishEndAt` 在未來(募款進行中,預設狀態)
  - **SaleItem** 同模式(demo 「上架中 / 預售中 / 已下架」三態)
  - **Cascading visibility demo**:**1 個 Charity** 設 `publishEndAt = <過去時間>`(合約已過期),該 Charity 底下保留 1 筆 Project + 1 筆 SaleItem **都不設**自己的 publishEndAt — 預期 public list 因 cascade 連 children 一起消失,**且**該 Charity 也不在 list 中。測試此 invariant 的 integration test 在 §11
  - **`displayOrder`**:全部預設 0;**指定 2 ~ 3 筆**設成 `-1` / `-2`(置頂),demo 「精選」排序生效

### 6.5 測試環境

- `testcontainers` 起 PostgreSQL 後,測試 `beforeAll` 跑 `prisma migrate deploy` + 最小 fixture(3 ~ 5 筆 per table)
- 完整 seed 留給 dev / demo 用

---

## 7. Category 內容與管理

### 7.1 初始 16 筆固定 seed(v0.6 — 截圖補件擴充;v0.7 補英文 displayName)

由 `prisma/seed/categories.ts` 寫入,key 不可變(被 application 層 `CategoryKey` 型別引用,改 key 屬 breaking change)。順序對齊 IMG_4879 / IMG_4881 模態的 grid:

| key | displayName(zh-TW) | displayNameEn(en) | displayOrder |
|---|---|---|---|
| `child_care` | 兒少照護 | Child Care | 10 |
| `animal_protection` | 動物保護 | Animal Protection | 20 |
| `special_medical` | 特殊醫病 | Special Medical Care | 30 |
| `elderly_care` | 老人照護 | Elderly Care | 40 |
| `disability_service` | 身心障礙服務 | Disability Service | 50 |
| `women_care` | 婦女關懷 | Women Care | 60 |
| `sports_development` | 運動發展 | Sports Development | 70 |
| `education_advocacy` | 教育議題提倡 | Education Advocacy | 80 |
| `environmental_protection` | 環境保護 | Environmental Protection | 90 |
| `diversity` | 多元族群 | Diversity | 100 |
| `media` | 媒體傳播 | Media | 110 |
| `public_issue` | 公共議題 | Public Issues | 120 |
| `arts_culture` | 文教藝術 | Arts & Culture | 130 |
| `community_development` | 社區發展 | Community Development | 140 |
| `poverty_relief` | 弱勢扶貧 | Poverty Relief | 150 |
| `international_aid` | 國際救援 | International Aid | 160 |

`displayOrder` 用 10 的倍數,方便日後在中間插值。

> **v0.5 → v0.6 變更**:原 6 筆(animal / environment / education / medical / elderly / disaster)為先前產品口頭確認;2026-06-14 截圖補件揭露 design 為 16 個 category。key rename 對齊新 displayName(`animal` → `animal_protection`、`elderly` → `elderly_care` 等);語意接近但範圍更廣(動物保護涵蓋流浪動物 + 其他動保)。前端 [spec 002 §3.1](../../../frontend/docs/specs/002-list-data.md#3-schemas--srclibschemaslistts) 同步更新。

### 7.2 為何 Category 是表而非 Prisma enum

| 角度 | 表(採用)| Prisma enum |
|---|---|---|
| 改 displayName(中文翻譯) | 改一筆資料 | 改 schema + migration |
| 加新分類 | 寫一筆資料 | 改 schema + migration |
| `displayOrder` 等 metadata | 內建欄位 | enum 無欄位概念 |
| FK 參照完整性 | ✅ DB enforce | ❌ enum 只是字串約束 |
| i18n(v0.7 已實現 `displayNameEn`,未來可再加)| ✅ 加欄位即可 | ❌ enum 無欄位 |
| Admin CRUD UI 接入 | ✅ 直接 | ❌ 改 enum 不能線上 |

key 本身仍可作為**穩定 identifier**,application 層用 union type 收斂:

```ts
// src/domain/category/keys.ts
export const CATEGORY_KEYS = [
  'child_care',                'animal_protection',
  'special_medical',           'elderly_care',
  'disability_service',        'women_care',
  'sports_development',        'education_advocacy',
  'environmental_protection',  'diversity',
  'media',                     'public_issue',
  'arts_culture',              'community_development',
  'poverty_relief',            'international_aid',
] as const
export type CategoryKey = typeof CATEGORY_KEYS[number]
```

### 7.3 為何 Category 是 M:N(不是 1:N)

ADR `002-charity-category-model.md` 詳述。摘要:

- 公益團體本來就常跨領域(慈濟同時做醫療 / 救難 / 教育)
- 1:N 強迫單一分類 = 資料失真,無法表達次要分類

### 7.4 子表繼承:Project / SaleItem 為何不自存 categories

ADR `002-charity-category-model.md` §理由 2。摘要:

- 一個動保團體底下的 projects / 商品本質都屬「動物」分類
- 各自 M:N 等於同樣資料寫 3 份,容易不一致
- filter 多 1 層 JOIN 的成本 < 資料一致性風險

### 7.5 升級觸發

| 觸發 | 處置 |
|---|---|
| Project 與主辦團體分類不同(如動保團體做了教育倡議專案)| 升級為「各自 M:N」(新增 `project_categories` / `sale_item_categories`);繼承可作 fallback |
| 分類有上下層級(動物 → 流浪動物 / 經濟動物)| `Category.parentId` self-FK |
| 分類加第 3 種語系(如日文)| 評估改 JSONB(`displayNameI18n jsonb { 'zh-TW', 'en', 'ja' }`)或 translation table — 詳見 backend ADR 004 §升級觸發 |
| 大量分類(> 50) | dropdown 改 search picker;API 加 `?q=` |

---

## 8. 命名對齊

呼應 ADR 003 / ADR 007:

| Prisma model | DB table |
|---|---|
| `Charity` | `charities` |
| `DonationProject` | `donation_projects` |
| `SaleItem` | `sale_items` |
| `Category` | `categories` |
| `CharityOnCategory` | `charity_categories` |

- 欄位 Prisma `camelCase` → DB `snake_case`(`logo_url`、`charity_id`、`category_id`、`display_order`、`assigned_at`、`created_at`、`updated_at`)
- Prisma client 出口:`prisma.charity.*`、`prisma.donationProject.*`、`prisma.saleItem.*`、`prisma.category.*`、`prisma.charityOnCategory.*`

---

## 9. Migration 計畫

### 9.1 Migration 檔

名稱:`<timestamp>_add_donation_items_with_categories`

內容:
1. Prisma DSL 改動 → `prisma migrate dev --create-only --name add_donation_items_with_categories` 自動產生五張表 + FK + 宣告的 index
2. 手動追加 §4.2 的 trigram GIN index SQL

### 9.2 建立順序(Prisma 自動處理,但明列以利 review)

```
categories      ← 字典表
charities       ← 主表
charity_categories      (FK → categories + charities)
donation_projects       (FK → charities)
sale_items              (FK → charities)
```

### 9.3 Rollback

```sql
DROP INDEX IF EXISTS ...;              -- 6 個 trgm index
DROP TABLE IF EXISTS sale_items;
DROP TABLE IF EXISTS donation_projects;
DROP TABLE IF EXISTS charity_categories;
DROP TABLE IF EXISTS charities;
DROP TABLE IF EXISTS categories;
-- pg_trgm extension 不主動刪
```

### 9.4 CI 驗證

- `prisma migrate deploy` 在 CI 跑,失敗 → fail build
- `prisma generate` 後 `tsc --noEmit`,確認下游 service 沒打字錯

---

## 10. 預留 namespace

本 spec 之後尚未實作的相關 entity:

| 未來 entity | 預留 model 名 | 關係 |
|---|---|---|
| 捐款交易 | `Donation` | `belongsTo Account` + `belongsTo DonationProject` |
| 義賣訂單 | `SaleOrder` / `SaleOrderItem` | `belongsTo Account` + `belongsTo SaleItem` |
| 收藏 | `Favorite` | M:N `Account ↔ (Charity ∣ Project ∣ SaleItem)` |

避免把 `DonationProject` 命名為 `Project`(語意太泛、易與「軟體專案」衝突),保留全名。

---

## 11. 測試策略(摘要)

| 測試類型 | 目標 |
|---|---|
| unit | 三 entity 的欄位驗證(name 1~120、description 1~500、`logoKey` / `coverImageKey` 必符合 spec 018 §5.1 regex)|
| unit | Category 欄位驗證(key `[a-z][a-z_]*`、displayName 1~80、displayOrder 為非負整數)|
| integration | `prisma.charity.create / findMany`、`donationProject.create`、`saleItem.create` 跑在 testcontainer:cursor 分頁 tiebreaker、`ILIKE` 命中 / 不命中、`pg_trgm` extension 在 migration 後存在 |
| integration | FK Restrict(Project/SaleItem):刪 Charity 在有 Project / SaleItem 時必須 throw |
| integration | FK NOT NULL(Project/SaleItem):不帶 `charityId` 必須 throw;帶不存在的 `charityId` 必須 throw FK constraint |
| integration | M:N 關聯:`charity.create({ data: { ..., categories: { create: [...] } } })` 能寫入 join 表;`findMany({ include: { categories: true } })` 能取出 |
| integration | M:N Cascade(Charity 端):刪 Charity 時 `charity_categories` 對應列自動清掉 |
| integration | M:N Restrict(Category 端):刪 Category 時若有 Charity 還掛著 → throw |
| integration | **子表繼承 filter**:Charity A 掛 `animal_protection`,新增一個 Project belong to A,query 取「`animal_protection` 分類的所有 Project」必須命中 |
| integration | Category unique key:寫入兩筆同 key 必須 throw |
| integration | **v0.7 i18n trgm index**:對 `name_en` 欄位 NULL row,`WHERE name_en ILIKE '%x%'` 不命中;對非 NULL row,trgm GIN 命中 |
| integration | **v0.7 i18n write**:`prisma.charity.create({ data: { name, description, nameEn: null }})` 能寫入(英文 nullable);讀回 `nameEn === null` |
| integration | **v0.7 Category displayNameEn**:16 筆 seed 後,每筆 `displayNameEn` 必為非空字串(不允許 nullable seed) |
| seed | `npx prisma db seed` 後:Category = 16 筆(對齊 §7.1),每筆有 `displayNameEn`;Charity ≥ 20、Project / SaleItem ≥ 30;每個 Charity 有 1 ~ 3 個 categories、≥ 1 Project + ≥ 1 SaleItem;`animal_protection` 至少 1 個 Charity 掛上;每張表的名稱皆含「流浪動物」≥ 1 筆;**`nameEn` / `descriptionEn` 至少 30% 非 null,且至少 1 筆含 `stray` 或 `animal`** |
| unit | **v0.9 `whereLive(now)` helper**(ADR 006 §2):4 條件全套(`deletedAt IS NULL` / `archivedAt IS NULL` / `publishStartAt 在過去 OR null` / `publishEndAt 在未來 OR null`);傳入不同 `now` 結果不同 |
| integration | **v0.9 預設 list query 排除 archived row**:seed `archivedAt = past`,`prisma.charity.findMany({ where: whereLive(now) })` 不包含該 row |
| integration | **v0.9 預設 list query 排除 deleted row**:seed `deletedAt = past`,結果不包含;**且** `findUnique({ where: { id: deletedId } })` walk 過 `whereLive` 的 service 層也回 null(route → 404) |
| integration | **v0.9 publish 時間視窗**:seed `publishStartAt = future`,當下 `whereLive(now)` 排除;`now = publishStartAt + 1s` 後納入 |
| integration | **v0.9 publish 結束**:seed `publishEndAt = past`,`whereLive(now)` 排除;`now = publishEndAt - 1s` 時納入 |
| integration | **v0.9 Cascading visibility(ADR 006 §3)**:setup → Charity A `publishEndAt = past`,A 底下 Project P1 / SaleItem S1 自身欄位全空(預設「永久上架」);`prisma.donationProject.findMany({ where: whereLiveWithParent(now) })` 必須**不**包含 P1;同樣 SaleItem 不包含 S1;Charity list 也不包含 A。**反向確認**:把 A.publishEndAt 設回未來,三個 endpoint 都重新看到 |
| integration | **v0.9 Cascading visibility — archived parent**:setup → Charity B `archivedAt = past`,旗下 Project P2 自身欄位全空;public list 不包含 P2 |
| integration | **v0.9 displayOrder 排序生效**:三筆 Charity displayOrder = -1 / 0 / 1,排序結果順序為 -1 → 0 → 1;同 displayOrder 內按 `createdAt DESC` |
| integration | **v0.9 FK Restrict 仍生效**:`prisma.charity.delete()`(hard delete)有 Project / SaleItem 必須 throw(soft delete 走 `deletedAt = now`,不觸發 FK 檢查) |

---

## 12. 開放問題

> v0.7 後 i18n 相關開放問題已大幅 close,詳見 backend ADR 004。
> 餘留問題:

- **Project / SaleItem 是否有自己的分類**(脫離主表繼承):目前繼承主表;若日後出現「動保團體做教育倡議專案」這種跨領域子資料,升級為各自 M:N(`project_categories` / `sale_item_categories`),繼承可作 fallback(見 §7.5)
- **Project / SaleItem 之間是否關聯**(例:義賣商品歸屬某募款專案):Figma 沒露,目前**無**;若日後出現,加 `SaleItem.donationProjectId nullable FK`,屬 additive
- **跨團體聯合活動(Charity-Project 多對多)**:目前 1:N 已足;若需要,新增 `CharityCollaboration` join 表(Project / SaleItem 維持主辦團體 `charityId`,join 表記錄協辦)
- **Charity GET 是否包含子表 count / 分類**:目前**否**;若 UI 需要,`?include=counts,categories`(spec 016 範圍)
- **Category 上下層級**(動物 → 流浪動物 / 經濟動物):目前**無**;若需要,`Category.parentId` self-FK
- ~~**Category i18n**~~ → v0.7 已實現 `displayNameEn`(zh-TW + en),見 §7.1
- **Category 是否升級為獨立表**:見 §7.4 觸發條件
- ~~**多語言 name / description**~~ → v0.7 已實現 suffix columns `nameEn` / `descriptionEn` / `contentEn`(zh-TW + en),見 backend ADR 004
- **i18n 第 3 語**(如日文):目前 2 語以 suffix columns 設計;若加第 3 語,ADR 004 §升級觸發 提供路徑(評估改 JSONB 或 translation table)
- ~~**Project / SaleItem 是否需要「狀態」欄位**~~ → v0.9 已用 `archivedAt` / `deletedAt` / `publishStartAt` / `publishEndAt` 四個 timestamp 取代 status enum;若日後需要工作流 status,ADR 006 §升級觸發 提供路徑
- ~~**是否需要 `displayOrder` / `featured` 欄位**~~ → v0.9 已實現 `displayOrder`(三主 entity + Category 統一);`featured` 用 `displayOrder` 負數即可
- ~~**soft delete**~~ → v0.9 已 by ADR 006 引入 `deletedAt` timestamp,擔任 soft-delete marker + 最小 audit
- **Cascading visibility 的 admin 預覽 endpoint**:本作業 out of scope,但約定先行(ADR 006 §5):未來實作必須走 `whereForAdmin({ includeArchived, includeDeleted, includeScheduled })` helper,**禁止** route handler 自拼 where。實際 admin UI 何時做留待後續 spec
- **`whereLive` / `whereForAdmin` helper 在哪一層**:ADR 006 §2 只規範「service-layer 提供」,具體放在 `domain/donation-item/where.ts` 還是 `lib/lifecycle/`?待 spec 016 落地時決定(因 list query 是 spec 016 owner)
- **過期 sweep job**:大量過期 Charity / Project / SaleItem 是否需要定期搬到 cold storage / archive partition?MVP 不處理,留 `publishEndAt` partial index 預備
- **S3 object 與 entity 生命週期解耦**(spec 018):soft delete 一個 entity 後,它的 S3 logoKey / coverImageKey object **不會自動清掉**(避免 recovery 時遺失)。要清需要批次 job 或 S3 lifecycle policy + delete marker — 本 spec 不涵蓋,ADR 006 「相關文件」已標示

---

## 13. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-13 | 初版,僅 `Charity` model(對應 brief v0.1 範圍) |
| 0.2 | 2026-06-13 | 範圍擴大至三個 tab。新增 `DonationProject` / `SaleItem`,FK 到 `Charity`,`onDelete: Restrict`。Seed 策略對齊三表;trigram index 涵蓋三表。對齊 brief v0.2 |
| 0.3 | 2026-06-14 | 移除 `DonationProject` / `SaleItem` 對 `Charity` 的 FK 與關聯。三 entity 改為完全獨立(對應 Figma 三 tab 各自獨立瀏覽,無聚合視圖需求)|
| 0.4 | 2026-06-14 | 回復 FK 設計(domain 語意更正確 — Charity 是主表,Project / SaleItem 是子表)。`charityId` NOT NULL,`onDelete: Restrict`。新增 §3.4 cascade 理由表、FK 相關 integration test、Project ↔ SaleItem 與 M:N 開放問題 |
| 0.5 | 2026-06-14 | 引入 Category 一級實體與 `CharityOnCategory` M:N join 表(對應 backend ADR 002)。移除 Charity / DonationProject / SaleItem 上的 `category String?` 欄位 — Charity 改 M:N 多分類,Project / SaleItem 不自存分類,filter 時 JOIN 主辦團體的 categories(子表繼承)。新增 §3.3 / §3.5 / §7 重寫 Category 處理、§4 索引補 join 表、§5 ER 圖含 Category、§6 seed 加 Category 與 join 寫入、§11 補 M:N 相關 test |
| 0.6 | 2026-06-14 | 截圖補件(IMG_4875-4883)欄位擴充:(1) Charity 加 `contactPhone` / `contactEmail` / `officialWebsite` / `approvalNo` 4 個 nullable 聯絡 / 核准欄位;(2) DonationProject 加 `coverImageUrl` / `content` (text) / `raisingApprovalNo` / `reliefApprovalNo`;(3) SaleItem 加同 4 個欄位 + `priceTwd` (Int NOT NULL);(4) §7.1 Category 由 6 筆擴為 16 筆,key rename 對齊新 displayName;(5) §6.4 seed 約束補新欄位多樣化要求。前端 spec 002 / 004 系列同步更新 |
| 0.7 | 2026-06-14 | 引入雙語系儲存(backend ADR 004 — Pattern A suffix columns):(1) Charity / Project / SaleItem 加 `nameEn` / `descriptionEn` nullable;Project / SaleItem 加 `contentEn` nullable;Category 加 `displayNameEn` nullable;(2) §4.2 trgm GIN index 補英文 6 個(中文 6 個 + 英文 6 個);(3) §6.4 seed 約束新增英文 ≥ 30% backfill + Category 100% backfill;(4) §7.1 Category 表加 displayNameEn 範例;(5) §11 補 3 個 i18n 相關 integration test;(6) §12 收束 i18n 相關開放問題 |
| 0.8 | 2026-06-14 | 引入 S3 物件儲存(spec 018):(1) `logoUrl String? @db.VarChar(2048)` → `logoKey String? @db.VarChar(512)`,同樣對 `coverImageUrl` → `coverImageKey`;DB 不再存完整 URL,改存 S3 key,**API 層用 `objectUrl(key)` 拼**(env 解耦、CDN 切換 config-only);(2) §3.3 驗證規則改為對 key pattern regex 而非 http(s) 驗證;(3) §6.4 seed 改為「先上傳圖檔到 LocalStack 再寫 key 進 DB」;(4) §11 unit test 改 regex 驗證;(5) ER 圖 `logoUrl?` → `logoKey?`。下游 spec 016 v0.10 + spec 017 v0.4 對齊 |
| 0.9 | 2026-06-14 | 引入 Entity lifecycle 統一模式(**backend ADR 006**):(1) 三主 entity(Charity / Project / SaleItem)各加 5 個欄位 — `displayOrder Int default 0` + `archivedAt DateTime?` + `deletedAt DateTime?` + `publishStartAt DateTime?` + `publishEndAt DateTime?`;Category 加 `archivedAt` / `deletedAt`(無 publish 時間);CharityOnCategory **不加**(join 表刪列即 unassign);(2) §3 約束 新增 lifecycle 區段:`whereLive` 4 條件 + Cascading visibility(Project / SaleItem public 必須通過 parent Charity 的 `whereLive`)+ 預設排序 `display_order ASC, created_at DESC, id DESC`;(3) §3.4 onDelete 改寫:soft delete 是業務動作不觸發 FK cascade,Restrict 仍正解 hard delete;(4) §4.1 索引重劃 — composite `(displayOrder, createdAt DESC, id DESC)` + `(publishEndAt)` + admin 全量 fallback;§4.1.1 partial index 列為「實測再加」;(5) §6.4 seed 加 archived / deleted / 三態 publish + cascading visibility demo(過期合約 Charity 含子表)+ displayOrder 置頂示範;(6) §11 補 8 個 lifecycle 相關 integration test(whereLive 4 條件、Cascading visibility 正反向、displayOrder 排序、FK Restrict 仍生效);(7) §12 關閉 3 個歷史開放問題(status 欄位、displayOrder、soft delete),新增 4 個(admin helper 位置、過期 sweep、S3 object 解耦);(8) Charity 的 publishStartAt / publishEndAt 對應「合作合約期限」,**不是**團體存在期限。下游 spec 016 / 017 同步引用 ADR 006 §2 / §3 |
| 0.10 | 2026-06-15 | §6.4 Charity logo 改 **featured-only**:30 個 complete charity 中**只有** `taiwan-stray-animal` 帶 `logoKey`,圖檔走 `prisma/assets/charity-placeholder.png`(從 frontend `public/figma/charity-placeholder.png` 複製,~165 KB);其餘 29 筆 `logoKey = null`,frontend 走預設 avatar。理由:1×1 透明 placeholder 跟「沒圖」在 UI 上等價,徒增 S3 / cache / bandwidth 成本。`seed.ts` post-condition 同步:`completeCharities` 由 9 欄位降為 8(去掉 `logoKey`)+ 新增 `charitiesWithRealLogo === slugLogos.size` 嚴格檢查。Project / SaleItem cover 暫不變(維持 1×1 placeholder)。Prod S3 orphan 一次性清理走 `backend/scripts/cleanup-orphan-charity-logos.ts`(需 admin creds,backend ECS role 無 `s3:DeleteObject` 遵守 spec 018 §5 least privilege)|
