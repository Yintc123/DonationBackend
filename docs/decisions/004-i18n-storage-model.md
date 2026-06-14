# 決策:多語系內容採 Suffix Columns(并列欄位)儲存

日期:2026-06-14

## 背景

本作業 mock data 包含動態內容(公益團體名、捐款專案描述、義賣商品說明、分類顯示名),產品 2026-06-14 確認需支援雙語:**繁體中文(zh-TW,主語)+ 英文(en,翻譯)**。

需決定:這些動態內容在 DB 怎麼存。

> **註**:UI 靜態文字(按鈕、標籤、錯誤訊息)走前端 i18n 檔(`next-intl` / `messages/*.json`),**不**進 DB,不在本 ADR 範圍。

## 選項評估

| 選項 | Schema 範例 | 利 | 弊 |
|---|---|---|---|
| **A. Suffix columns**(採用)| `name String` + `nameEn String?` | Prisma type 完整;`pg_trgm` GIN 直接套;查詢直觀;index 配置簡單 | 加第 3 語要 migration |
| B. JSONB | `name Json` 存 `{ "zh-TW": "...", "en": "..." }` | 加語免 migration;欄位整齊 | Prisma type 變 `Json` 弱化;`pg_trgm` 需 functional index;query 全要 `name->>'zh-TW'` |
| C. Translation table | `Charity` + `CharityTranslation { charityId, locale, name, description }` | 最正規;scale 到 N 語;單表 schema 乾淨 | 每 query 都要 `include` + group by locale;seed 工作翻倍;Prisma 表達囉嗦 |
| D. 不存 DB,只前端 i18n | DB 只存 zh-TW,前端用 i18n 檔翻譯 | 最簡 | 動態內容(團體名)前端無從預知;違反「translation 跟著資料走」原則 |

## 決策

採用 **A:Suffix Columns**。

### 多語系欄位列表

| Entity | 主語欄位(zh-TW)| 翻譯欄位(en)| 非多語系欄位 |
|---|---|---|---|
| `Charity` | `name`, `description` | `nameEn`, `descriptionEn` | `logoUrl`, `contactPhone`, `contactEmail`, `officialWebsite`, `approvalNo` |
| `DonationProject` | `name`, `description`, `content` | `nameEn`, `descriptionEn`, `contentEn` | `coverImageUrl`, `raisingApprovalNo`, `reliefApprovalNo` |
| `SaleItem` | `name`, `description`, `content` | `nameEn`, `descriptionEn`, `contentEn` | `coverImageUrl`, `priceTwd`, 兩個字號 |
| `Category` | `displayName` | `displayNameEn` | `key`, `displayOrder` |

共 **9 個新 nullable 欄位**(2×3 entities for name+desc + 1×2 for content + 1×1 for Category)。

### 約束

- **主語(zh-TW)為 NOT NULL** — source of truth,永遠有
- **翻譯(en)為 nullable** — 允許「未翻譯」狀態,API 層 `item.nameEn ?? item.name` fallback
- 為何不對等 NOT NULL:翻譯常常 lag 主語(內容團隊先寫中文、英文後補),強制 NOT NULL 會卡寫入流程

### Cascade 規則

無 — suffix columns 是 entity 本身的欄位,沒有跨表 cascade 問題。

## 理由

### 1. Pattern A 的「不能 N 語」對本作業不是缺點

本作業只 2 語,且短期不會擴張:

- Figma 設計只有中文 UI
- 加英文是補件(2026-06-14 確認)
- 未來加日 / 越南語等屬「未發生情境」

「需要 migration 才能加語」的痛點,要在語系數 >= 3 ~ 4 才會明顯。本作業在這之前不會撞到。

### 2. `pg_trgm` GIN 搜尋無痛延伸

spec 015 §4.2 既有 6 個中文 trgm GIN index(三表 × name + description)。Pattern A 下,英文版本只需多 6 個對等 index:

```sql
CREATE INDEX charities_name_en_trgm_idx ON charities USING gin (name_en gin_trgm_ops);
-- ... ×6
```

NULL 不會被 GIN 索引(PG 預設行為)— 沒英文翻譯的列在英文搜尋下自然不命中,**就是我們要的 locale-specific 搜尋語意**。

JSONB(option B)若要支援同樣搜尋,需 functional index:

```sql
CREATE INDEX charities_name_zh_trgm_idx ON charities
  USING gin ((name->>'zh-TW') gin_trgm_ops);
CREATE INDEX charities_name_en_trgm_idx ON charities
  USING gin ((name->>'en') gin_trgm_ops);
```

- 數量沒省到;且 functional index 在 Prisma migration 流程中需手寫 SQL,維運成本反而高

### 3. Prisma type 強保證

Pattern A:`nameEn: string | null` — 編譯時 narrow:

```ts
const displayName = charity.nameEn ?? charity.name  // ✅ string
return ctx.json({ name: displayName })              // ✅ TS happy
```

JSONB:`name: Prisma.JsonValue` — 永遠是 unknown,要 cast:

```ts
const nameObj = charity.name as { 'zh-TW': string; en?: string }
//                              ^^^^^ runtime 還是可能爆,type cast 是承諾不是保證
```

Translation table:每次 query 都要 `include: { translations: true }`,然後 reduce 找 locale。code 散在 N 個地方。

### 4. 雙重觸控避免:fallback 邏輯集中

API 層用一個 small helper 統一 fallback:

```ts
function localize<T extends Record<string, any>>(
  item: T,
  fields: ReadonlyArray<keyof T>,
  locale: 'zh-TW' | 'en',
): T {
  if (locale === 'zh-TW') return item
  const result: any = { ...item }
  for (const f of fields) {
    const enKey = `${String(f)}En` as keyof T
    result[f] = item[enKey] ?? item[f]   // ← fallback to zh-TW
    delete result[enKey]                  // 不外洩英文欄位給 zh-TW client
  }
  return result
}
```

handler 不必到處寫 `??`,response shape 對 client 仍是 `name: string`(無 suffix 欄位外洩)。

### 5. Seed / mock 簡單

Pattern A:

```ts
await prisma.charity.create({
  data: {
    name: '財團法人流浪動物基金會',
    nameEn: 'Stray Animal Foundation',
    description: '致力於流浪動物收容...',
    descriptionEn: 'Dedicated to stray animal rescue...',
  }
})
```

JSONB:序列化 JSON literal,人讀差。Translation table:寫 2 次 create(主表 + 翻譯表),或 nested create 增加 boilerplate。

## 不採用其他選項的權衡

### 不採用 B(JSONB)

如 §理由 2 / §3 所述:Prisma type 弱化、search index 不省、查詢繁瑣。**JSONB 適合非結構化 metadata**(如 audit log payload),**不**適合需要 query / search / display 的核心 domain 欄位。

如果未來真要 N 語(> 4 種),JSONB 才是合理升級路徑。本作業未到那個量級。

### 不採用 C(Translation tables)

正規化最高,但對本作業是過度設計:

- 每個 list query 多 1 個 include + 2 個 join
- Frontend 拿到 array of translations 要自己挑 locale
- Seed 寫 2 倍(主表 + 翻譯表各一條)
- 主表 schema 反而不直觀(name 在哪?)

升級觸發:多語系團隊需要「per-locale 編輯權限」、「翻譯狀態追蹤」(已翻 / 待審 / 已校稿)時,改 translation table 是合理的 — 那時就不只是儲存模型問題,而是 i18n workflow。

### 不採用 D(不存 DB,只前端 i18n)

**對 UI 靜態文字**:正確選項,本 ADR 不否定。
**對動態內容**:不可行 — 前端不可能預先翻譯 mock data 內的所有團體名(無限長 tail)。

## 實作要點

### Schema

完整 Prisma schema 見 spec 015 v0.7 §3。摘要:

```prisma
model Charity {
  name            String   @db.VarChar(120)
  description     String   @db.VarChar(500)
  nameEn          String?  @db.VarChar(120)
  descriptionEn   String?  @db.VarChar(500)
  // ... 非多語系欄位
}
```

### Migration 順序

1. `ALTER TABLE` 加新 nullable 欄位(冪等,允許 backfill)
2. `CREATE INDEX` 6 個 trgm GIN(對齊既有中文 index 命名規則加 `_en_` 中綴)

不需 backfill 流程(allowed null)。

### API 層

- Request:`Accept-Language: zh-TW`(預設)或 `en`
- 不支援的 locale → fallback 到 zh-TW(不回錯)
- Response shape **不變**(`name: string`),由 server 端解析 header 後選欄位
- 詳細 spec 016 v0.8 / spec 017 v0.3

### 搜尋語意

- `q` 對 **當前 locale 的 name + description** 做 ILIKE(中文 client 找中文欄位,英文 client 找英文)
- 沒英文翻譯的列在英文搜尋下不命中(GIN NULL 不索引的天然行為,符合 locale-specific 語意)
- 不做跨 locale union(避免 mix 結果)

### Seed

- 中文(主語)**全部必填**
- 英文翻譯 **30% 以上有 backfill**(供 demo 英文 client 不至於全空)
- 至少 1 筆每張表的英文 `name` / `description` 含 "stray" 或 "animal"(對應「流浪動物」demo query 在英文 client 也命中)

## 升級觸發

| 觸發 | 處置 |
|---|---|
| 第 3 種語系加入(如日文) | 評估改 JSONB 或 translation table — 加 4 ~ 6 個欄位是上限,再多就難看 |
| 翻譯需 workflow(per-locale 編輯權限、翻譯狀態 metadata)| 改 translation table 並引入 `TranslationStatus` enum |
| 大量 i18n 內容(每個 entity > 10 個多語系欄位)| 改 translation table 避免主表欄位爆炸 |
| 多幣別(`priceTwd` → `priceMinor + currency`)| **獨立議題**,不在本 ADR 範圍(currency ≠ locale)|

## 下游影響

- **Spec 015 v0.6 → v0.7**:Prisma schema 加 9 個 nullable 英文欄位、§4.2 trgm GIN 補英文、§6 seed 補英文 mock、§12 開放問題刪「i18n 預留」
- **Spec 016 v0.7 → v0.8**:加 `Accept-Language` 請求語意、search 對 locale 欄位做 ILIKE、§5.1 補不支援 locale 的 fallback 規則
- **Spec 017 v0.2 → v0.3**:detail response 同 fallback 邏輯
- **本 ADR 與 ADR 001 / 002 的關係**:三者正交。001 = entity FK,002 = Category M:N,本 ADR = 多語系儲存模型,互不影響

## 變更紀錄

| 日期 | 變更 |
|---|---|
| 2026-06-14 | 初版。鎖定 Pattern A(suffix columns)+ Accept-Language API exposure |
