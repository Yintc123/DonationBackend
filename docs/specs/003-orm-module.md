# Spec 003:ORM 模組(Prisma 整合層)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.2 |
| 日期 | 2026-06-13 |
| 適用範圍 | `backend/src/lib/db`、`backend/prisma/` |
| 相關 ADR | `docs/decisions/002-backend-framework.md`(Fastify)、`docs/decisions/003-database-postgresql.md`(PostgreSQL) |
| 相關 spec | `001-environment-config.md`(`DATABASE_URL`)、`005-error-handling.md`(交易 throw 後的 rollback 行為) |

---

## 1. 目的

定義 backend 服務如何將 Prisma 整合進 Fastify,涵蓋:

- `PrismaClient` 的生命週期(初始化、注入、關閉)
- Schema 與 migration 工作流
- 型別如何串連 Fastify route schema → Prisma → response
- 錯誤處理映射(Prisma error code ↔ HTTP status)
- 交易使用規則
- 測試策略(`testcontainers`)
- Seed 機制

---

## 2. 範圍

### 2.1 In scope

- ORM 整合層(infrastructure)
- 規範如何**使用** Prisma,不規範**用什麼 model**
- Migration 工作流(本地 / CI / prod)

### 2.2 Out of scope

- 具體資料模型(entity 名、欄位、enum 值、關聯) — 由後續資料模型 spec 處理
- 索引策略細節 — 屬資料模型 spec 範疇,本檔僅給原則
- 多租戶 / 多區域分片 — 目前無此需求

---

## 3. 檔案結構與位置

```
backend/
├── prisma/
│   ├── schema.prisma          # 單一 schema 來源
│   ├── migrations/            # 版控
│   └── seed.ts                # dev seed(可選)
└── src/
    ├── lib/
    │   └── db/
    │       ├── client.ts      # PrismaClient instance / 工廠
    │       ├── errors.ts      # Prisma error → AppError 映射
    │       └── index.ts       # 對外 re-export
    └── plugins/
        └── prisma.ts          # Fastify plugin,注入 fastify.prisma
```

理由:

- `prisma/` 為 Prisma CLI 約定位置,不改
- `src/lib/db/` 集中所有與 ORM 邊界相關的邏輯,業務代碼不直接 `import { PrismaClient }`,而是用 `fastify.prisma` decorator 或 `lib/db` 的工廠

---

## 4. `PrismaClient` 生命週期與注入

### 4.1 注入機制

採用 **Fastify plugin + `fastify.decorate`** 模式:

```ts
// src/plugins/prisma.ts(草案)
import fp from 'fastify-plugin'
import { PrismaClient } from '@prisma/client'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
  }
}

export default fp(async (fastify) => {
  const prisma = new PrismaClient({
    log: fastify.config.NODE_ENV === 'development'
      ? ['query', 'warn', 'error']
      : ['warn', 'error'],
  })
  await prisma.$connect()
  fastify.decorate('prisma', prisma)
  fastify.addHook('onClose', async () => {
    await prisma.$disconnect()
  })
})
```

使用端:`request.server.prisma.<modelName>.findUnique(...)`

### 4.2 規則

- **單一 instance**:整個 process 共用一個 `PrismaClient`,不在 request 範疇建立新 instance
- **連線於 `register` 階段建立**:啟動失敗即 fail-fast
- **關閉於 `onClose` hook**:確保 SIGTERM / 測試 teardown 都會釋放連線
- **業務代碼禁直接 `import { PrismaClient }`**:一律走 `fastify.prisma`,便於測試替換

### 4.3 連線池

- 預設由 Prisma 管理,連線數 = `num_physical_cpus * 2 + 1`
- prod 需在 `DATABASE_URL` query string 加 `?connection_limit=N&pool_timeout=T` 明確設定
- dev 採預設值

---

## 5. Schema 與命名慣例

呼應 ADR 003 §「實作要點 / 命名」:

| 層 | 慣例 | 範例 |
|---|---|---|
| Prisma model 名稱 | `PascalCase` 單數 | `model Foo`、`model BarBaz` |
| Prisma 欄位 | `camelCase` | `createdAt`、`parentId` |
| DB 對應 table | `snake_case` 複數(用 `@@map`) | `@@map("foos")` |
| DB 對應欄位 | `snake_case`(用 `@map`) | `@map("created_at")` |
| 主鍵 | `uuid()`,欄位名 `id` | `id String @id @default(uuid())` |
| 時間戳 | `createdAt` / `updatedAt`,皆必填 | `@default(now())` / `@updatedAt` |
| 貨幣型別 | `Decimal` 對應 `numeric(12, 2)` | `amount Decimal @db.Decimal(12, 2)` — 任何金額欄位通用 |
| Enum | 大寫底線分隔 | `enum Visibility { PUBLIC, PRIVATE, INTERNAL }` |

> 上表範例**僅示範格式**,不代表已決定的資料模型;實際 model / 欄位 / enum 值由資料模型 spec 擁有。

### 5.1 Schema 拆檔策略

- 暫定**單一 `schema.prisma`**(Prisma 原生)
- 模型超過 20 個再評估 multi-schema(Prisma 5+ 支援 `prismaSchemaFolder` preview)

---

## 6. Migration 工作流

| 場景 | 指令 | 用途 |
|---|---|---|
| 本地開發新增 / 修改 model | `prisma migrate dev --name <desc>` | 產生 migration 檔 + 套用到 dev DB |
| 本地重置(資料清空) | `prisma migrate reset` | dev only,絕不對 stage / prod 使用 |
| CI 套用既有 migration | `prisma migrate deploy` | 不產生新檔,僅套用 |
| stage / prod 部署 | `prisma migrate deploy` | 部署 pipeline 自動跑 |
| 預覽 SQL(不套用) | `prisma migrate dev --create-only` | 審查破壞性 migration |

### 6.1 規則

- **migration 檔案進入版控**,與業務 PR 一同 review
- 破壞性 migration(rename / drop column / type change):
  - 必須先 stage 驗證
  - 拆兩步:先擴展(新欄位 / 雙寫)→ 再收縮(刪舊欄位)
  - PR description 註明回滾方式
- 不允許手動編輯既有 migration 檔,只能新增

---

## 7. 型別整合(Prisma + Fastify Schema)

呼應 ADR 002 §「Fastify schema-driven 型別端到端」:

```
Fastify route schema (TypeBox)  →  request 型別
            ↓                              ↓
       validate input             route handler 收 typed body
                                           ↓
                              fastify.prisma.x.method({ ... })   ← Prisma 型別
                                           ↓
                              Prisma return 型別 ──────────────→ response shape
                                                                      ↓
                                                          Fastify response schema 驗證
```

### 7.1 規則

- Route handler 中**不應出現 `any`**:request body 由 TypeBox 推導、Prisma 結果由 generated type 推導
- Prisma 結果若要回給 client,**必須**過 response schema(避免不小心洩漏內部欄位,例如密碼雜湊、內部 token 等)
- 共用 DTO 型別放 `src/types/`,從 Prisma type 衍生(例:`Pick<SomeModel, 'id' | 'name'>`)

---

## 8. 錯誤處理

### 8.1 Prisma 已知錯誤映射

| Prisma code | 意義 | HTTP | 應用層 error |
|---|---|---|---|
| `P2002` | unique constraint violation | 409 Conflict | `ConflictError` |
| `P2025` | record not found | 404 Not Found | `NotFoundError` |
| `P2003` | foreign key constraint failed | 400 Bad Request | `BadRequestError` |
| `P2024` | timed out fetching a connection | 503 Service Unavailable | `ServiceUnavailableError` |
| 其他 known request error | (記 log + 500) | 500 Internal Server Error | `InternalError` |
| `PrismaClientValidationError` | 開發期 bug | (不應流到 prod) | 500 + 警報 |

### 8.2 實作位置

- 集中於 `src/lib/db/errors.ts`:`mapPrismaError(err): AppError`
- 提供 `withPrismaErrors` wrapper 或 Fastify 全域 error handler 統一轉換
- **不在 route handler 內逐個 `try/catch` 比對 code**,避免重複

### 8.3 訊息規則

- 對外回應:**不可**含 SQL、table 名稱、PII
- 內部 log:可含 code / meta,但 PII 遮罩

---

## 9. 交易使用規則

### 9.1 何時必須用交易

- **跨 model 寫入需同時成功 / 失敗**:多筆相關 INSERT / UPDATE 任一失敗時整批回滾
- **讀取 → 計算 → 寫回**(需避免 race condition):同時多個 actor 可能更新同一筆 row 時,防止 lost update

> 具體業務場景(何時觸發)由業務 spec 定義;本 spec 僅規範**形式**。

### 9.2 兩種寫法

```ts
// (a) 互動式(可在中間做條件判斷)
await fastify.prisma.$transaction(async (tx) => {
  const row = await tx.entity.findUnique({ where: { id } })
  if (!row || !meetsPrecondition(row)) {
    throw new AppError(/* see spec 005 */)
  }
  await tx.entity.update({ where: { id }, data: { /* mutate */ } })
  await tx.relatedEntity.create({ data: { /* relate to row */ } })
}, { timeout: 5000 })

// (b) 批次(無相依、純並列原子)
await fastify.prisma.$transaction([
  fastify.prisma.foo.create({ /* ... */ }),
  fastify.prisma.bar.create({ /* ... */ }),
])
```

### 9.3 規則

- 預設 `timeout: 5000ms`,超過視業務調整,**不設無上限**
- 互動式交易內**禁止外部 IO**(HTTP call、Redis 大查詢)——會卡 DB 連線
- 並發控制:讀後寫的場景用 `SELECT ... FOR UPDATE`(Prisma 5+ 支援 `lock` 選項)或樂觀鎖(`@version` 欄位)
- 跨 service / 跨 DB 不寫分散式交易,用 outbox pattern(留作未來,目前無需)

---

## 10. 測試策略

呼應 backend `CLAUDE.md`:**不 mock Prisma**,用 `testcontainers` 起真實 PostgreSQL。

### 10.1 啟動方式

- **integration / e2e test suite 共用一個 container**,suite-level setup
- 每個 test 用 **transaction rollback** 或 **truncate** 隔離資料
- container 啟動代價約 2-5 秒,可接受;啟動失敗 → CI fail-fast

### 10.2 結構草案

```ts
// tests/helpers/db.ts
export async function setupTestDb() {
  const container = await new PostgreSqlContainer('postgres:16').start()
  process.env.DATABASE_URL = container.getConnectionUri()
  execSync('npx prisma migrate deploy')
  const prisma = new PrismaClient()
  return { prisma, container }
}

// vitest globalSetup or beforeAll
```

### 10.3 隔離策略

| 策略 | 速度 | 安全性 | 使用時機 |
|---|---|---|---|
| Transaction rollback(`BEGIN` ... `ROLLBACK`) | 快 | 與 prod 行為略異(無 commit hook) | 多數 unit-of-DB 測試 |
| Truncate all tables | 中 | 高 | 跨交易測試、e2e |
| 重啟 container | 慢 | 最高 | 不建議 |

預設用 **truncate**(可靠且簡單);若效能成瓶頸再切 rollback。

### 10.4 Seed for tests

- 提供 factory function:每個 model 一個 `make<ModelName>(overrides?)`,回填合理預設、可覆寫
- **不共用 dev seed**,測試 fixture 獨立

---

## 11. Seed

### 11.1 Dev seed

- 檔案:`prisma/seed.ts`
- 指令:`npx prisma db seed`(在 `package.json` 加 `prisma.seed` 設定)
- 內容:**最小 happy-path 資料**——讓 `npm run dev` 起來後即可手動操作主要流程,具體 row 由業務 spec 決定
- 純 idempotent:upsert,可重複跑

### 11.2 Test seed

- 不用 `prisma/seed.ts`,改用 factory function(見 §10.4)
- 每個測試自己決定要塞什麼資料,避免測試之間互相依賴

### 11.3 Prod

- **prod 不跑 seed**,任何初始資料用 migration 內的 raw SQL(`prisma migrate dev --create-only` + 編輯)

---

## 12. 效能原則

### 12.1 N+1 防範

- 預設使用 `include` / `select`,**禁止**用 loop 內 `findUnique`
- 寫測試或 review 時若見「for 內查 DB」直接 blocking

### 12.2 `select` vs `include`

- 只用得到部分欄位 → `select`(payload 小、型別精準)
- 需要完整 relation → `include`
- 兩者不可混用於同層

### 12.3 索引

- 任何 `where` / `orderBy` / `groupBy` 條件涉及的欄位**必須**有索引
- 高基數欄位優先(boolean 不必加)
- 複合索引順序:**等值條件在前,範圍條件在後**
- 索引變動需在 PR description 註明預期影響

### 12.4 Query logging

- dev:`log: ['query']` 全開,方便觀察
- prod:`log: ['warn', 'error']`,避免 PII 與效能損耗
- slow query 紀錄留作未來(可整合 `prisma-extension-logger` 或 OpenTelemetry)

---

## 13. 觀測性

- Prisma metrics(`prisma.$metrics`)留作未來;目前以 `pino` log 覆蓋足夠
- 健康檢查:`GET /health` 不查 DB(避免雪崩),另設 `GET /health/db` 跑 `SELECT 1`

---

## 14. 開放問題

- **soft delete**:採 `deletedAt` 欄位 + middleware 過濾,還是真刪?待資料模型 spec 決定
- **Audit 欄位**:是否每張 table 加 `createdBy` / `updatedBy`?待業務情境決定,目前不急
- **多 schema 拆分**:目前單檔,model 數量上來再評估
- **Read replica**:Prisma 5+ 支援,但本專案讀寫量未到瓶頸,暫不導入

---

## 15. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-13 | 初版 |
| 0.2 | 2026-06-13 | 移除業務領域詞彙(`User` / `Donation` / `balance` / `point` / `admin user` / `project`),範例改用 `Foo` / `SomeModel` / `entity` / `relatedEntity` 等抽象名;`enum` 範例改為 `Visibility { PUBLIC, PRIVATE, INTERNAL }`;§5 命名表加註腳明示「範例僅示範格式」;§9 交易條件改為形式描述;§11.1 dev seed 內容改為「最小 happy-path」;§14 audit 措辭改通用 |
