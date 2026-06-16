# 決策:UUID 主鍵以 PostgreSQL `TEXT` 形式儲存(暫不採 `@db.Uuid`)

日期:2026-06-16

## 背景

`schema.prisma` 全表主鍵採 `String @id @default(uuid())`,Prisma 預設將其 emit 為 PostgreSQL `TEXT` 欄位(36-char 帶 hyphen 的 UUID 字串),**非** PG 原生 `uuid` 型別(16-byte binary)。

ADR 003 (PostgreSQL) §「型別豐富」與 ADR 007 (Prisma) §「PostgreSQL 型別對齊」都提及「`uuid` 原生對應」是選 PG / Prisma 的理由之一,目前 schema 並未兌現該句——所有 id 落為 `TEXT`。

問題是:**這算不算技術債?是否該補上 `@db.Uuid` 把欄位改成 PG 原生 `uuid`?**

本 ADR 在本期(demo / 面試交付階段)定錨:**維持 TEXT,prod 化前再評估**,並把 TEXT 形式的具體優點記錄下來,避免未來重複辯論。

## 「為何用 UUID」已在他處定錨

本決策**不**辯論「UUID vs bigint」——該選擇由 ADR 013 §F (完全匿名訂單) 強制決定:`Order.id` 必須不可枚舉,bigint 直接破功;為了 schema 一致性,其餘 entity 也統一用 UUID。

本 ADR 只處理「UUID 用 TEXT 還是 `@db.Uuid`」這一層。

## 選項評估

| 選項 | 儲存 / 筆 | DB 層型別驗證 | Application 改動 | Migration 成本 |
|---|---|---|---|---|
| **TEXT**(現狀,本期採用)| 36 bytes | ❌(`TEXT` 接受任意字串) | 無 | 已實作 |
| `@db.Uuid`(PG 原生 16-byte binary)| 16 bytes | ✅(非 UUID 字串插入直接 reject) | 無(Prisma client TS 型別仍為 `string`) | 一支全表 `ALTER COLUMN ... TYPE uuid USING id::uuid` |

兩者**對 application code 完全透明**:Prisma 在 TS 端皆回傳 `string`,handler / service 寫法不變。差異純粹在 DB 層儲存與型別嚴格度。

## TEXT 形式的優點(本 ADR 重點記錄)

### 1. 零配置,符合 Prisma 慣例

`String @id @default(uuid())` 是 Prisma 文件首頁範例。維持預設值意味:

- 新進開發者讀 schema 不需查 `@db.Uuid` 的特殊語義
- Prisma 升級 / breaking change 風險最低(預設行為改動的機率遠低於 attribute 語法)
- 與既有 `String?` 多語系欄位、`String` content 欄位等**型別敘述一致**,schema 看一眼就懂

### 2. 跨工具操作無摩擦

開發 / debug 路徑中,UUID 以 string 形式被處理的場景遠多於以 binary 形式:

- `psql` 互動:`WHERE id = 'abc-...'` 直接寫,**不需 `::uuid` cast**
- DBeaver / TablePlus:複製貼上 36-char 字串即可比對
- `curl` / API 測試:request URL / body 本來就是 string
- log / Sentry:錯誤訊息直接帶 `orderId=abc-...`,搜尋友善

`@db.Uuid` 在這些情境下會時常遇到 `operator does not exist: uuid = text` 之類的 cast 錯誤,debug 時多一層心智負擔。

### 3. JSON / API / event payload 原生序列化

- API response body:Fastify 序列化 `string` 為 JSON string,零轉換
- log / audit / Redis event payload:皆為 string,寫入 / 讀取對稱
- frontend / BFF 跨層傳遞:全鏈路 string,沒有 binary buffer 換手點

`@db.Uuid` 在 application 層雖然 Prisma 已抹平為 string,但任何**繞過 Prisma 的直連**(raw SQL、PG driver、未來引入的 streaming / CDC 工具)都會遇到 binary ↔ text 的轉換點。

### 4. seed / fixture / 測試決定性高

`prisma/seed` 與 integration test 大量使用 **hard-coded UUID** 來建立固定資料:

```ts
await prisma.charity.create({
  data: { id: '00000000-0000-0000-0000-000000000001', name: 'Test' }
})
```

TEXT 直接吃這種 hard-coded 值,完全不需驗證格式(雖然我們仍會寫合法 UUID,避免未來改 `@db.Uuid` 卡住)。配合 backend `CLAUDE.md` 的「不 mock DB、用 testcontainers」原則,測試資料可讀性 > 微小儲存差異。

### 5. 跨 DB 遷移友善(理論性,但保留)

`uuid` 是 PostgreSQL 專有型別。雖然 ADR 003 已決議「不換 DB」,但:

- 用 SQLite 跑 lightweight smoke test 的能力被保留(雖然 ADR 003 / CLAUDE.md 已禁止 in-memory mock,此優勢實際不會兌現)
- 未來真要遷雲端託管的 serverless DB(D1、Turso)時,schema 不依賴 PG 專屬型別

→ 此優點**承認是次要的**,放這裡是補完性質,不作為主要理由。

### 6. 升級路徑單向且無痛

TEXT → `@db.Uuid` 是**單一 migration**:

```sql
ALTER TABLE "charities" ALTER COLUMN "id" TYPE uuid USING id::uuid;
-- 對所有 FK 欄位重複(donation_projects.charityId 等)
```

PostgreSQL 對合法 UUID string 的 `::uuid` cast 是無損的;反向 (`uuid → text`) 也合法。**今天不做,將來可以做**;反之若先綁 `@db.Uuid` 想退回 TEXT,雖然技術上可行,但會被質疑為「降級」。先寬鬆、後收緊是更安全的演進方向。

## TEXT 形式的代價(誠實列出)

不假裝 TEXT 在所有面向都優於 `@db.Uuid`:

| 面向 | 代價 | 本期影響 |
|---|---|---|
| 儲存空間 | 每筆 +20 bytes(36 - 16) | 本期最大表是 `orders`,demo 預估 < 10 萬筆 → 多耗 ~2 MB,可忽略 |
| Index 比較速度 | string compare 略慢於 binary | 本期 query 走 index seek + range scan,差異 < 1ms,使用者無感 |
| DB 層型別驗證 | `TEXT` 接受任意字串(application 層 TypeBox schema + Prisma client 已擋,但 raw SQL 通道無保障) | 本期無 raw SQL,風險為零;未來引入 raw SQL / CDC 才浮現 |
| ADR 003 / 007 文字一致性 | 兩份 ADR 提的「`uuid` 原生」與現狀有落差 | 本 ADR 即為對齊文件——明確記錄「本期選 TEXT,將來可改 `@db.Uuid`」 |

## 決策

1. **本期(demo / 面試交付階段)維持 `String @id @default(uuid())` 的 TEXT 預設**,不加 `@db.Uuid`
2. **schema 不再為此事改動**,避免無實質收益的 migration 噪音(spec 015 / 021 已多支 migration,再加一支純為換型別的會稀釋 commit history)
3. **所有新增 entity 沿用同一形式**(`String @id @default(uuid())`),保持 schema 內 100% 一致
4. **ADR 003 §「型別豐富」與 ADR 007 §「PostgreSQL 型別對齊」中「`uuid` 原生」一句,以本 ADR 為補充說明**:意思是「未來保留採用 PG `uuid` 型別的選項」,而非「目前就用」

## 將來何時改 `@db.Uuid`(觸發條件)

不是「絕對不改」,而是「現在改沒有 ROI」。出現下列任一條件時重新評估:

- 任一表預估超過 100 萬筆,index 大小或 write throughput 開始進入 profiler
- 引入 raw SQL 或繞過 Prisma 的 DB 通道(報表、ETL、CDC)
- prod 化前的 schema review 階段(評估期約 1 人天)
- 採用 UUID v7(時間排序變體)時——v7 的優勢在 binary 形式才完整(b-tree index locality),屆時同步切 `@db.Uuid` ROI 最高

## 不在本 ADR 範圍

- **UUID v4 vs v7**:v7 對 b-tree index locality 更好,但本期表規模感受不到。未來切 `@db.Uuid` 時一併評估,屆時開新 ADR
- **bigint 主鍵**:已由 ADR 013 §F 排除(`Order.id` 必須不可枚舉)
- **複合主鍵 / surrogate key**:`CharityOnCategory` 採 `@@id([charityId, categoryId])`,屬個別 entity 設計,不影響本 ADR 一般規則

## 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-16 | 初版——記錄 TEXT 形式的優點與將來改 `@db.Uuid` 的觸發條件 |
