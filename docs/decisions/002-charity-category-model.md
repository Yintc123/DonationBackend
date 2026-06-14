# 決策:Charity 分類採 M:N 模型,子表(Project / SaleItem)繼承主表分類

日期:2026-06-14

## 背景

Spec 015 v0.4 把「分類」處理為 Charity / DonationProject / SaleItem 三表各自的 `category String?` 欄位(application 層 6 個 key 白名單)。這個設計面臨兩個問題:

1. **不符合現實**:公益團體常跨領域(慈濟同時做醫療 / 救難 / 教育),固定單一 category 等於資料失真
2. **設計缺失**:Figma 的「全部」filter dropdown 只畫了按鈕,沒畫展開後的選項面板 — spec 015 §7 暫定 6 個 key 是合理假設,但要落地需正式定義

產品 2026-06-14 確認:

> 點擊「全部」按鈕會出現選單,選單裡是公益團體的分類。公益團體類別對公益團體是多對多 — 一個類別可以有多個團體,一個團體可以有多個類別。

由此衍生三個進一步的子問題,確認如下:

- **DonationProject / SaleItem 是否也有分類?** → 繼承主辦團體的分類(透過 join)
- **分類是否一級實體?** → 是,獨立 `Category` 表
- **Filter UI 單選 / 多選?** → 單選(`?category=<key>`,v0.2 鎖定;見 §「議題 A 結果」),M:N 仍支援單選查詢

## 選項評估

| 選項 | 描述 | 利 | 弊 |
|---|---|---|---|
| **A. M:N + 子表繼承**(採用)| `Category` + `CharityOnCategory` join 表;Project / SaleItem 自身不存分類,filter 時 JOIN 主辦團體的 categories | 語意正確;資料不重複;改 Charity 分類即時影響所有子表;表數最少(5 張) | Project tab 過濾需 3-table join(性能在中等資料量無感) |
| B. 三 entity 各自 M:N | 三個 join 表(`charity_categories` / `project_categories` / `sale_item_categories`)| 查詢最快(1 層 join);各 entity 分類獨立 | 資料重複(同團體下的 projects 幾乎都會抹同樣分類);seed / 維護成本 3x;表數 7 張 |
| C. 只 Charity tab 有 filter | Project / SaleItem tab 不接受 category | schema 最簡;貼合 Figma(只畫 Charity frame)| UI 三 tab 不一致;產品實際確認三 tab 都要 filter 等於違反需求 |
| D. 固定 enum / 字串白名單(v0.4 現狀)| 不引入 Category 表,單一 category 字串欄位 | 表數最少(3 張);實作最簡 | **無法表達一個團體屬多個分類** — 違反產品確認 |
| E. JSONB array of keys | `categories: string[]` 存在 Charity 表 | 不必 join 表;單表查詢 | 無 FK 不能保證 key 合法;查詢用 array contains;無分類 metadata(displayName / order);違反 ADR 003「型別端到端」原則 |

## 決策

採用 **A:M:N + 子表繼承**:

```
Category 1 ─── N CharityOnCategory N ─── 1 Charity
                                          │ 1
                                          ├── N DonationProject(過濾時 JOIN charity 的 categories)
                                          └── N SaleItem       (同上)
```

新增表:`categories` + `charity_categories`(join);**移除** Charity / DonationProject / SaleItem 上的 `category String?` 欄位。

## 理由

### 1. M:N 對應 domain 現實

公益團體跨領域是常態,不是例外:
- 慈濟 = 醫療 + 救難 + 教育 + 環保
- 喜憨兒基金會 = 教育 + 弱勢支持 + 就業
- 紅十字 = 醫療 + 救難 + 國際援助

強迫單一分類會出現「主要分類」與「次要分類」的人為判斷,且 filter UI 在「次要」分類下會漏掉該團體。M:N 是唯一不損失資訊的模型。

### 2. 子表繼承(option A vs B)

DonationProject / SaleItem 的分類**應該等於主辦團體的分類**,理由:

- 一個動保團體發起的所有 projects / 商品,本質都屬「動物」分類 — 同一團體不會推出「金融科技」項目
- 若各自 M:N(option B),seed / 維護要在三張 join 表寫一樣的資料,容易不一致(改 Charity 分類沒改 Project 分類 → 顯示錯亂)
- 繼承等於「真實事相」(分類是團體的屬性,不是專案 / 商品的屬性)

代價是 Project tab filter 要多 1 層 join:

```sql
SELECT p.*
FROM donation_projects p
JOIN charity_categories cc ON cc.charity_id = p.charity_id
WHERE cc.category_id = $1
```

中等資料量(萬筆級)在 `charity_categories(category_id)` + `donation_projects(charity_id)` 雙索引下能 index nested loop,無感。

> **取捨明確化**:option B 用「重複資料」換「查詢少 1 層 join」。本作業資料量小、寫入幾乎沒有,join 成本可忽略 — 不值得用資料一致性風險去換。

### 3. Category 一級實體(option A 內含的 Q2 決策)

獨立 `Category` 表(而非 JSONB / enum)帶來:

- **FK enforcement**:Charity 不可能掛到不存在的分類
- **Metadata**:`displayName`(中文顯示)、`displayOrder`(dropdown 排序)、未來 `icon` / `i18n` 預留
- **Admin CRUD-ready**:未來後台要 CRUD 分類不必 migration
- **前端不必寫死對照表**:`GET /v1/donation/categories` 回完整清單

JSONB array(option E)的「不必 join 表」優點在 M:N 量級下不顯著,且失去 FK 與 metadata,違反 ADR 003 對 PostgreSQL 型別系統的使用原則。

### 4. UI 單選 / DB 多對多不矛盾(Q3)

Figma dropdown UI 看起來是單選(`全部` + 1 selected),API 收 `?category=<key>` 即可(v0.2 — 詳見 §「議題 A 結果」)。M:N 對單選查詢的 SQL 還是 simple:

```sql
SELECT c.*
FROM charities c
JOIN charity_categories cc ON cc.charity_id = c.id
WHERE cc.category_id = $1
```

若未來 UI 改多選,改 `?category=<key1>,<key2>` → `WHERE cat.key IN (...)`,**Schema 不動**,純 API contract additive。

## 不採用其他選項的權衡

### 不採用 B(三 entity 各自 M:N)

捨棄理由詳見 §理由 2。本質:**「資料一致性 > 查詢效能微小差距」**。

### 不採用 C(只 Charity 有 filter)

產品已確認三 tab 都實作。即使 Figma 只畫 Charity frame,等於非範圍而是「Figma 缺圖」(brief v0.3 已標記)。三 tab UI 不一致(只有一個 tab 有 dropdown)會引起評審反問。

### 不採用 D(固定 enum / 單一 category)

直接違反產品確認的 M:N 需求。

### 不採用 E(JSONB array)

- 無 FK:任意字串都能寫入,資料品質失控
- 無 metadata:dropdown 顯示要寫死前端
- 查詢用 `categories @> ARRAY['animal']`,Prisma 表達不順
- 違反 ADR 003 / 007「型別端到端」精神

JSONB 適合「彈性 metadata」,**不**適合「需要關聯 / 查詢 / 顯示」的核心 domain entity。

## 實作要點

### Prisma model

完整 Schema 見 spec 015 v0.5 §3。摘要:

```prisma
model Category {
  id           String   @id @default(uuid())
  key          String   @unique @db.VarChar(40)    // "animal"
  displayName  String   @db.VarChar(80)             // "流浪動物"
  displayOrder Int      @default(0)
  // ...
  charities CharityOnCategory[]
}

model CharityOnCategory {
  charityId  String
  categoryId String
  assignedAt DateTime @default(now())

  charity  Charity  @relation(..., onDelete: Cascade)    // 刪 Charity 連帶刪關係
  category Category @relation(..., onDelete: Restrict)   // 刪 Category 若有團體用 → 擋下

  @@id([charityId, categoryId])
  @@index([categoryId])     // 反向查「該分類下所有團體」
}

model Charity {
  // ... 移除 category String? 欄位
  categories CharityOnCategory[]
}

// DonationProject / SaleItem 同樣移除 category String? 欄位
```

### Cascade 規則

| FK | onDelete | 理由 |
|---|---|---|
| `CharityOnCategory.charityId` → `charities` | **Cascade** | 刪 Charity 時相應 join 列也清掉(symbolic link,不是業務資料) |
| `CharityOnCategory.categoryId` → `categories` | **Restrict** | 刪 Category 時若有團體還掛著 → 擋下,強制管理員先解除掛載 |

兩邊不同方向,刻意如此 — Charity 是主表,Category 是字典表。

### Migration 順序

```
1. categories
2. charities                (sibling)
3. charity_categories       (FK → 1 + 2)
4. donation_projects        (FK → 2)
5. sale_items               (FK → 2)
6. + 6 個 trgm GIN index    (charities/donation_projects/sale_items × name+description)
```

### Seed

- 先 seed 6 個 Category(對應 spec 015 v0.4 暫定白名單)
- 每個 Charity 隨機指派 1 ~ 3 個 Category(`CharityOnCategory` 落表)
- DonationProject / SaleItem **不**直接寫 categoryId,filter 時透過 join 取得
- 詳見 spec 015 v0.5 §6

### API 對外

- 新增 `GET /v1/donation/categories` 回傳完整分類清單(dropdown 用)
- 三 list endpoint 接受 `?category=<key>`(單選,v0.2)
- Item response **不**含 categories(Figma card 不顯示分類);需要時走 `?include=categories`
- 詳見 spec 016 v0.5 §3 / §4

## 升級觸發

以下情境出現時,需重新評估本決策(對應 spec 015 v0.5 §12 開放問題):

| 觸發 | 評估方向 |
|---|---|
| 「某 Project 與其主辦團體分類不同」需求(例:動保團體做了一次教育倡議專案)| 升級為 option B(各自 M:N),Project / SaleItem 加自己的 join 表;繼承可作為 fallback |
| 分類有上下層級(動物 → 流浪動物 / 經濟動物)| `Category.parentId` self-FK |
| ~~分類本身需 i18n~~ → v0.7 已實現(`displayNameEn` suffix column);若需第 3 種語系 → 見 backend ADR 004 §升級觸發 | — |
| 多選 filter | API 改 `?category=<key1>,<key2>`,Schema 不動 |
| **分類動態化**(後台 admin 任意建分類,key 不再是 application-level enum)| API 改回 `?categoryId=<uuid>` — 避免 free-form key 造成 SQL injection 與型別 narrowing 失效。本 ADR §「議題 A 結果」§安全考量 詳述 |
| 大量分類(> 50)| dropdown 改為 search / tag picker;API 加 `?q=` 搜分類 |

## 下游影響

- **Spec 015 v0.5**(資料模型) — Category / CharityOnCategory 兩張新表;移除 entity `category` 欄位
- **Spec 016 v0.5**(API) — 新增 `GET /v1/donation/categories`;list endpoint 從 `?categoryId=<uuid>` 改為 `?category=<key>`(v0.9 完成,見 §「議題 A 結果」)
- **Brief v0.4**(frontend) — 移除「Filter dropdown 分類選項待釐清」缺口
- **本 ADR 與 ADR 001 的關係** — 兩者正交:ADR 001 定義 Charity-Project-SaleItem 之間的 FK(本質關聯),本 ADR 定義 Charity-Category 之間的 M:N(屬性關聯)

## 議題 A 結果(v0.2 — 2026-06-14)

初版 ADR 把 filter API 寫成 `?categoryId=<uuid>`,後續評估發現與 brief v0.6 URL sync(`?category=<key>`)不一致。經 14 個維度評估,**決定改用 `?category=<key>`**:

### 結論

```
GET /v1/donation/charities?category=animal_protection
GET /v1/donation/donation-projects?category=animal_protection
GET /v1/donation/sale-items?category=animal_protection
```

TypeBox schema:`Type.Union(CATEGORY_KEYS.map(Type.Literal))` — 16 literal union,route 層直接擋拼錯(400 `CATEGORY_UNKNOWN`)。

### 關鍵理由(完整評估見 spec 016 v0.9 + 對話紀錄)

1. **URL 對使用者可讀 / 可分享 / 可記憶**:`/donate?category=medical_care` vs `/donate?categoryId=550e8400-...`
2. **跨環境穩定**:zh / staging / prod 都同一個 key,不受 reseed 影響
3. **TypeScript type 自帶 enum**:`CategoryKey` literal union 比 `string` 安全
4. **REST 慣例對齊**:enum-like filter 用 key(GitHub / Stripe / Linear 模式)
5. **Brief v0.6 已選邊**:對齊 brief 比反向改 brief 容易
6. **效能無差**:`categories.key` 為 `@unique` B-tree index,16 筆字典下 lookup O(log n);亦可 in-memory cache 把 JOIN 完全省掉
7. **錯誤語意清晰**:拼錯 `animals` 直接 400(用 UUID 拼錯只能回 200 + 空 list,client 無法分辨 typo 與 dead reference)

### 安全考量

`?category=<key>` 安全前提是 **key 為 application-controlled enum**(寫死於 `CATEGORY_KEYS` union),由 TypeBox `Type.Union(literals)` 在 route 層攔住任意輸入。若分類動態化(admin 任意建 key),這層防護消失,需:

- 改回 `?categoryId=<uuid>`,或
- 加上 character whitelist(如 `^[a-z][a-z_]{1,40}$`)+ DB 存在性檢查

詳見 §升級觸發「分類動態化」一行。

## 變更紀錄

| 日期 | 變更 |
|---|---|
| 2026-06-14 | 初版。定錨 Charity-Category M:N + 子表繼承 + 獨立 `Category` 表 + 單選 API |
| 2026-06-14 (v0.2) | 議題 A 收尾:filter API 從 `?categoryId=<uuid>` 改為 `?category=<key>`。新增「議題 A 結果」、「安全考量」、「分類動態化」升級觸發。資料庫 schema(`charity_categories.category_id` FK)**維持 UUID 內部 identifier**,僅 API 對外 contract 改 key |
