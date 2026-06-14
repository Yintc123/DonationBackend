# Prisma 工作流(model 定義、migration、同步)

| 欄位 | 內容 |
|---|---|
| 類別 | Guide(怎麼做,不是契約) |
| 適用範圍 | `backend/prisma/`、所有改 schema / migration / Prisma client 的場景 |
| 相關 ADR | 專案級 ADR 003(PostgreSQL)、ADR 007(Prisma 為 ORM);backend ADR 005(`lib / domain / routes / schemas` 分層) |
| 相關 spec | `../specs/003-orm-module.md`、`../specs/015-charity-data-model.md` |

---

## 1. 「Model 在哪裡?」— Prisma 跟傳統 ORM 不同

來自 Sequelize / TypeORM / Mongoose 背景的開發者第一個問題通常是「**為什麼沒有 `src/models/Charity.ts`?**」。

答案:**Model 的真相在 `prisma/schema.prisma`**,不是 TS class。Prisma 從 DSL 自動產出 TS 型別 + 查詢 client,業務邏輯則放在 `src/domain/`(對齊 backend ADR 005)。

### 對照

```
傳統 ORM(active record)             Prisma(data mapper)

src/models/Charity.ts                 prisma/schema.prisma   ← model 真相
  class Charity extends Model {         model Charity {
    @Column() name: string                id String @id ...
    @DeleteDateColumn() deletedAt         name String ...
    static async findActive() {...}     }
  }                                     ↓ npx prisma generate
const c = await Charity.findActive()  node_modules/@prisma/client(auto)
                                      ↓
                                      src/domain/donation-item/list-services.ts
                                        export async function listCharities(...) {
                                          return prisma.charity.findMany({
                                            where: whereLive(now),
                                          })
                                        }
                                      ↓
                                      const c = await listCharities({ prisma, ... })
```

### 各層職責

| 層 | 檔案 / 路徑 | 職責 | 對應 OOP 的什麼 |
|---|---|---|---|
| **Schema 定義** | `prisma/schema.prisma` | 表結構、欄位、關聯、index、cascade | model class 的欄位 + decorator |
| **Migration** | `prisma/migrations/<ts>_*/migration.sql` | DB 從舊狀態到新狀態的 SQL diff | (傳統手工 migration 或 sequelize-cli) |
| **Generated client** | `node_modules/@prisma/client`(不進 git) | TS 型別 + 查詢 API | model class 自動產出的 type / API |
| **業務邏輯** | `src/domain/` | 業務規則、查詢組裝 | model class 的 instance / static method |
| **使用點** | `src/routes/` | 薄 HTTP handler 呼叫 domain | controller |

> 詳細分層約定見 [backend ADR 005](../decisions/005-source-tree-layer-convention.md)。

---

## 2. 四個東西要保持同步

```
prisma/schema.prisma  ← 你改的地方(source of truth)
     │
     ├──→ prisma/migrations/<timestamp>_<desc>/migration.sql   ← SQL diff
     ├──→ 實際 PostgreSQL 資料庫(dev / test / prod 各一份)
     └──→ node_modules/@prisma/client(TS 型別 + 查詢 client)
```

Prisma 提供指令讓這四者**同步**。90% 場景一個指令搞定。

---

## 3. 日常 dev 工作流:`prisma migrate dev`

改完 `schema.prisma` 後:

```bash
npx prisma migrate dev --name <change-description>
```

這一行**一次做四件事**:

1. **比對 schema vs DB**,自動產生 SQL diff
2. **寫入** `prisma/migrations/<timestamp>_<change-description>/migration.sql`
3. **套到本地 DB**(`jkodonation_dev`)
4. **跑 `prisma generate`**,重生 TS 型別 + client

跑完 IDE 立刻看到新欄位 / 新 model 的型別補全。

### 範例:加一個欄位

```prisma
// prisma/schema.prisma
model Charity {
  // ... 既有欄位 ...
  taxId  String?  @db.VarChar(20)     // ← 新增
}
```

```bash
npx prisma migrate dev --name add_charity_tax_id
```

Prisma 自動生成:

```sql
-- prisma/migrations/<timestamp>_add_charity_tax_id/migration.sql
ALTER TABLE "charities" ADD COLUMN "taxId" VARCHAR(20);
```

套到 DB + 重生 client。`prisma.charity.findMany(...)` 回傳的 row 立刻多 `taxId: string | null` 欄位,**TypeScript 立刻知道**。

---

## 4. 指令對照表

| 情境 | 指令 | 行為 |
|---|---|---|
| **本地改 schema 想看效果** | `npx prisma migrate dev --name <desc>` | 生 migration + 套 DB + 重生 client |
| **混合手寫 SQL(extension / partial index / trigger)** | `npx prisma migrate dev --create-only --name <desc>` 然後手動編輯 SQL,再 `npx prisma migrate dev` | 兩階段:先產出空白 migration,你 append 純 SQL,再套 DB |
| **只想重生 TS 型別** | `npx prisma generate` | 不動 DB |
| **同步 DB 狀態** | `npx prisma migrate status` | 列出 migration 套了沒、有沒有 drift |
| **拉同事的 schema 改動** | `git pull && npx prisma migrate dev` | 自動套 pending migration |
| **prod / CI 部署** | `npx prisma migrate deploy` | **只套已存在的 migration,不生新的** |
| **本地 DB 砍掉重來** | `npx prisma migrate reset` | drop DB + 跑所有 migration + 跑 seed |
| **查 schema 格式** | `npx prisma format` | 對 `schema.prisma` 做 prettier-like 排版 |
| **打開 GUI 看 DB** | `npx prisma studio` | 本機 5555 port 開瀏覽器 GUI |
| **實驗性 schema 改動(不留歷史)** | `npx prisma db push` | **跳過 migration** 直接套 schema(僅 dev,絕對不用 prod) |

---

## 5. 混合手寫 SQL:pg_trgm / 自訂 index 工作流

Prisma DSL **表達不了**:

- PostgreSQL extension(`CREATE EXTENSION`)
- GIN / GiST / BRIN 索引
- Partial index(`WHERE deleted_at IS NULL`)
- Trigger / stored procedure
- View / materialised view

這些都走「**`--create-only` → 手動編輯 → `migrate dev`**」工序。

### 範例(spec 015 v0.9 真實案例)

```bash
# 1. 改 schema.prisma — 加 5 個 model + 一般 index
vim prisma/schema.prisma

# 2. 產出空白 migration(不套 DB)
npx prisma migrate dev --create-only --name add_donation_items_with_categories

# 3. 手動編輯生成的 SQL,在尾巴 append pg_trgm 區段
cat >> prisma/migrations/20260614052843_add_donation_items_with_categories/migration.sql << 'EOF'

-- ── pg_trgm extension + GIN indexes (spec 015 §4.2) ─────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "charities_name_trgm_idx"
  ON "charities" USING gin ("name" gin_trgm_ops);
-- ... 11 more GIN indexes ...
EOF

# 4. 套 DB + 重生 client(此時 Prisma 看到 migration 還沒套)
npx prisma migrate dev
```

> **`--create-only` 跟 `migrate dev` 的差別**:`--create-only` 讓你在 Prisma 套 DB 之前介入 SQL。常見 case 是「Prisma 自動產的部分對,但**還要加東西**」。

---

## 6. 同步流程:dev → CI → prod

```
你的開發機              CI(GitHub Actions)        Prod(ECS)
─────────────           ──────────────────────       ─────────────
prisma migrate dev      prisma migrate deploy        prisma migrate deploy
       │                       │                            │
       ▼                       ▼                            ▼
寫 SQL 檔               讀 git 進來的 SQL 檔        讀 git 進來的 SQL 檔
進 git              ──→ 套到 testcontainer    ──→  套到 RDS
+ commit                       │                  (.aws/task-definition.json
                               ▼                   裡的 migrate one-shot task)
                          integration test
                          通過才繼續
```

### 核心原則

- **`migrate dev` 只在開發機**(產生 migration 檔)
- **`migrate deploy` 在所有其他環境**(只套已產出的 migration,不生新的)
- migration SQL **檔進 git 跟 schema.prisma 一起 commit**(契約)

> CI / prod 自動跑 migrate deploy 的串接細節見 `../specs/014-deployment-container.md`。

### 對應到本專案的 commit 習慣

```bash
git add prisma/schema.prisma prisma/migrations/<new>/
git commit -m "feat(charity): add tax id"
```

兩個一起 commit — schema 跟 migration 是同步契約,**禁止單獨 commit schema 而不 commit migration**(deploy 會炸)。

---

## 7. 拉同事的改動:`git pull` 之後做什麼

```bash
git pull
npm install                   # ← Prisma 在 postinstall 自動跑 generate
npx prisma migrate dev        # ← 套同事新增的 migration 到你的 dev DB
npm test                      # ← testcontainer 內部會自動跑 migrate deploy
```

> `npm install` 自動觸發 `prisma generate`(`package.json` 的 prisma 設定)。如果 IDE 還是看不到新型別,手動跑 `npx prisma generate` + 重啟 TS Server(VSCode:Cmd-Shift-P → "TypeScript: Restart TS Server")。

---

## 8. 反 pattern(別做)

| 做法 | 為什麼不該做 |
|---|---|
| **手動改 PostgreSQL** | schema.prisma 不知道你改了什麼,下次 `migrate dev` 會試圖把你的手動改動「修回去」,可能造成 data loss |
| **直接編輯歷史 migration SQL** | migration 檔是 immutable 歷史 — 改了會讓 prod 跟 dev 的 hash 對不上,`migrate deploy` 會 fail |
| **prod / staging 跑 `prisma migrate dev`** | 它會檢測 drift、可能 reset DB(資料全沒) |
| **`prisma db push` 進 git** | 跳過 migration,沒有歷史可追,prod 沒法重現 |
| **改 schema.prisma 但不 generate migration** | dev DB 跟 schema 不同步,IDE 型別跟 DB 行為對不上,debug 痛苦 |
| **單獨 commit schema.prisma 不 commit migration**(或反過來)| 兩者是同步契約,只 commit 一邊 → 別人 / CI / prod 跑不起來 |

---

## 9. 排查

### 「我改了 schema 但 IDE 沒看到新型別」

```bash
npx prisma generate
# VSCode: Cmd-Shift-P → "TypeScript: Restart TS Server"
```

### 「`migrate dev` 說我 DB drift 了」

某人手動改了 DB,或某次 migration 跑壞。**dev 環境**最快復原:

```bash
npx prisma migrate reset     # ⚠️ drop DB + 重套全部 migration + 跑 seed
```

**prod / staging 絕不執行**。Prod 真的有 drift 的處理路徑:導出資料 → 手動寫補丁 migration → 套上 → 用 `prisma migrate resolve --applied <id>` 標記為已套。

### 「migration 檔有 conflict(同事改了同個欄位)」

Git rebase 後 timestamp 順序可能對不上。處理:

- 刪掉自己的 migration 檔 → 重 `prisma migrate dev --name <new-name>` 重新生(Prisma 會根據最新 schema 重新 diff)
- 或保留並改 filename 的 timestamp 讓自己的排在對方之後(再檢查 SQL 還合不合理)

### 「seed 跑完 unique constraint 衝突」

seed 不是 idempotent。本專案 seed 寫法是「**先 deleteMany 再 create**」(`prisma/seed.ts`),所以重跑沒問題。若你寫新 seed 子檔,記得放 deleteMany 在前段。

### 「testcontainer integration test 跑很慢 / migrate 跑很久」

每次 test run 都 spin up 全新 container + 跑所有 migration。一般 < 10s。若超過 30s,檢查 migration 是不是有不必要的全表 rewrite(`ALTER COLUMN type`、`CREATE INDEX` 大表)。

---

## 10. 常用指令速查

| 動作 | 指令 |
|---|---|
| 改完 schema,套 DB + 重生 client | `npx prisma migrate dev --name <desc>` |
| 手寫 SQL 混合工序 | `npx prisma migrate dev --create-only --name <desc>` → 改 SQL → `npx prisma migrate dev` |
| 只重生 client | `npx prisma generate` |
| 查 migration 狀態 | `npx prisma migrate status` |
| 拉同事改動 | `git pull && npx prisma migrate dev` |
| Prod 部署 | `npx prisma migrate deploy`(CI 已串好) |
| 砍掉重來(僅 dev) | `npx prisma migrate reset` |
| Format schema | `npx prisma format` |
| GUI 看 DB | `npx prisma studio` |
| Seed | `npx prisma db seed`(等價 `npm run prisma:seed`) |

---

## 11. 相關文件

- [spec 003 — ORM 模組](../specs/003-orm-module.md)(Prisma client 包裝、命名規約)
- [spec 015 — Donation data model](../specs/015-charity-data-model.md)(本專案最大宗 model)
- [ADR 005 — Source tree layer convention](../decisions/005-source-tree-layer-convention.md)(`prisma/` vs `src/domain/` 職責分界)
- [專案 ADR 007 — ORM 選 Prisma](../../../docs/decisions/007-orm-prisma.md)(為什麼用 Prisma 不用 TypeORM)
- [Prisma 官方文件](https://www.prisma.io/docs)
