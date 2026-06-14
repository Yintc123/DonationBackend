# Spec 015:捐款項目資料模型(Charity / DonationProject / SaleItem / Category)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.8 |
| 日期 | 2026-06-14 |
| 適用範圍 | `backend/prisma/schema.prisma`、`backend/prisma/seed.ts`、`backend/src/domain/donation-item/*`、`backend/src/domain/category/*` |
| 相關 ADR | `../../docs/decisions/003-database-postgresql.md`(專案級)、`../../docs/decisions/007-orm-prisma.md`(專案級)、`../decisions/001-donation-item-relations.md`(backend 級 — 三 entity 1:N NOT NULL FK)、`../decisions/002-charity-category-model.md`(backend 級 — Charity-Category M:N + 子表繼承)、`../decisions/004-i18n-storage-model.md`(backend 級 — 多語系 suffix columns 設計)|
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

### 1.3 Out of scope

- **API 行為**(分頁、查詢參數、回應 shape)— 由 spec 016 擁有
- **使用者收藏 / 追蹤** — 不在本次作業需求
- **金流、捐款交易、訂單、收據** — 不在本次作業需求,但 model 命名需避免日後衝突(見 §10)
- **soft delete / audit log** — 沿用 backend 整體尚未決議的政策,本 spec 不單獨引入

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
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  donationProjects DonationProject[]
  saleItems        SaleItem[]
  categories       CharityOnCategory[]

  @@index([createdAt(sort: Desc), id(sort: Desc)])
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
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  charity Charity @relation(fields: [charityId], references: [id], onDelete: Restrict)

  @@index([charityId])
  @@index([createdAt(sort: Desc), id(sort: Desc)])
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
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  charity Charity @relation(fields: [charityId], references: [id], onDelete: Restrict)

  @@index([charityId])
  @@index([createdAt(sort: Desc), id(sort: Desc)])
  @@map("sale_items")
}

// 分類字典表
model Category {
  id             String   @id @default(uuid())
  key            String   @unique @db.VarChar(40)    // 程式用識別,如 "animal_protection"
  displayName    String   @db.VarChar(80)             // UI 顯示,zh-TW,如 "動物保護"
  displayNameEn  String?  @db.VarChar(80)             // en,如 "Animal Protection"
  displayOrder   Int      @default(0)                 // dropdown 排序
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
| `createdAt` | `timestamptz` | NOT NULL | `now()` | cursor 分頁主鍵 |
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
| `displayOrder` | `int` | NOT NULL | 預設 `0` | dropdown 排序;同值依 `key` 字典序 |
| `createdAt` | `timestamptz` | NOT NULL | `now()` | |
| `updatedAt` | `timestamptz` | NOT NULL | `@updatedAt` | |

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

### 3.4 為何 Project / SaleItem 的 `onDelete: Restrict`

| 規則 | 行為 | 適不適合本場景 |
|---|---|---|
| `Cascade` | 刪 Charity → 連帶刪所有 Project / SaleItem | ❌ Charity 被誤刪 / 暫時下架時連帶吞掉歷史專案,不可逆 |
| **`Restrict`** | 刪 Charity 前必須先把所有 Project / SaleItem 處理掉(刪除或改 FK) | ✅ 防誤刪;日後若有 soft delete / archive,在這層擋下 |
| `SetNull` | FK 變 null | ❌ 違反 §2 NOT NULL 約定 |

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
| `(createdAt DESC, id DESC)` | cursor 分頁 tiebreaker | `ORDER BY createdAt DESC, id DESC LIMIT ?` |
| `(charityId)`(僅 Project / SaleItem)| 「某團體底下所有專案 / 商品」過濾、FK lookup;`charity_categories` JOIN 反向 | `WHERE charity_id = ?` |
| `categories.(displayOrder)` | dropdown 排序 | `ORDER BY display_order, key` |
| `categories.(key)` | unique constraint + key lookup | `WHERE key = ?` |
| `charity_categories.(charityId, categoryId)` | composite PK,正向查「該團體有哪些分類」 | `WHERE charity_id = ?` |
| `charity_categories.(categoryId)` | 反向查「該分類下有哪些團體」(Charity tab filter 主路徑、Project/SaleItem tab filter 的 JOIN 起點)| `WHERE category_id = ?` |

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
- **Project / SaleItem 是否需要「狀態」欄位**(草稿 / 上架 / 下架 / 結案):Figma 未露,目前不加;若評審反問「下架項目怎麼處理」,可口頭交代「目前以刪除實現,日後加 status enum」
- **是否需要 `displayOrder` / `featured` 欄位**:Figma 沒露,目前不加
- **soft delete**:整體 backend 尚未決議;若引入,FK `onDelete: Restrict` 改為配合 `deletedAt` 過濾邏輯

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
