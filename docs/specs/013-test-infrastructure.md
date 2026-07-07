# Spec 013:測試基礎建設(Test Infrastructure)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.3 |
| 日期 | 2026-06-15 |
| 適用範圍 | `backend/vitest.workspace.ts`、`backend/tests/**`、`backend/src/**/*.test.ts` |
| 相關 ADR | (無新 ADR;承 `backend/CLAUDE.md` 的 TDD 鐵則) |
| 相關 spec | `001-environment-config.md`(test env vars)、`003-orm-module.md` §10(`testcontainers` 起 Postgres)、`005-error-handling.md`(error 斷言)、`006-redis-module.md`(`testcontainers` 起 Redis)、`007-auth-flow-google-oidc.md`(MSW 攔截 Google OAuth)、`011-health-check.md`(probe 測試) |

---

## 1. 目的與範圍

### 1.1 目的

`backend/CLAUDE.md` 已寫死 TDD 鐵則、測試工具選型、不 mock Prisma/Redis 的政策,但「**工具設定怎麼長、container 怎麼起、fixture 怎麼寫、CI 怎麼跑**」尚無共識。本 spec 補上這層基礎建設,使:

- 第一份 integration test 不必再做設定決策(已固化)
- 多人 / 多份 PR 寫測試不會產生風格漂移
- 切換 unit → integration → e2e 三層在 IDE / CLI / CI 一致

### 1.2 In scope

- Vitest 設定(`vitest.workspace.ts` / setup 檔)
- `testcontainers` 啟動策略(共用 vs 隔離、生命週期)
- 資料隔離策略(truncate 細節,呼應 spec 003 §10.3 決議)
- Fixture 工廠模式(`make<Entity>(overrides)`)
- 外部服務 mock 邊界(MSW、時間、隨機)
- `npm` script 設計
- CI 與本地的差異與兼容

### 1.3 Out of scope

- 具體業務測試案例 — 由業務 spec 自帶
- 效能 / 負載測試(`k6` / `autocannon`)— 後續可獨立 spec
- 視覺迴歸 / contract test(Pact)— 本期不採用
- Mutation testing — 不引入

---

## 2. 工具棧

| 用途 | 選擇 | 版本下限 | 來源 |
|---|---|---|---|
| Test runner | `vitest` | 2.0 | `CLAUDE.md` |
| HTTP 測試 | `fastify.inject()` | 內建於 fastify 5 | 不起 port、純函式呼叫 |
| DB 隔離 | `testcontainers` + PostgreSQL 16 | testcontainers 10 | 與 prod 同型 |
| Redis 隔離 | `testcontainers` + Redis 7 | 同上 | 不用 ioredis-mock |
| 外部 HTTP 攔截 | `msw` | 2.0 | Google OAuth / 第三方 webhook |
| 時間 / 隨機 | `vi.useFakeTimers()` / 注入 clock + idGenerator | 內建 | 決定性測試 |
| Coverage | `@vitest/coverage-v8` | 2.0 | 印報告不卡 build |

任何替換需更新 `CLAUDE.md` 與本 spec。

---

## 3. 檔案結構

```
backend/
├── vitest.workspace.ts          # 多 project 設定(unit / integration / e2e)
│                                #   v0.3 — 同步實作:各 project 為 inline 定義,
│                                #   無獨立 vitest.config.ts base config
├── tests/
│   ├── helpers/
│   │   ├── container.ts         # PostgreSQL / Redis / LocalStack(S3)testcontainers 啟動
│   │   ├── app.ts               # buildApp() 工廠,共用 plugin 註冊
│   │   ├── db.ts                # v0.3 — 同步實作:目前為 reject stub;
│   │   │                        #   真正 truncate 在 per-test-setup.ts
│   │   └── msw.ts               # createGoogleMsw() 工廠(per-test,非全域 server)
│   ├── integration/             # route + Prisma + Redis 真容器
│   ├── e2e/                     # 多 route 串接、OAuth callback 用 MSW
│   └── setup/
│       ├── global-setup.ts      # 整 suite 啟動 container、migrate(無 MSW server)
│       └── per-test-setup.ts    # fake timer reset、FLUSHDB、truncate(寫死表清單)
└── src/
    └── **/*.test.ts             # unit:與 source 同檔名 / 同目錄
```

> **v0.3 — 同步實作**:上表原列而**目前不存在**的項目——`vitest.config.ts`(workspace 各 project inline 定義,不繼承 base)、`tests/helpers/factories/`(§7 工廠模式整體未實作)、`tests/tsconfig.json`(僅 root 有 `tsconfig.json` + `tsconfig.build.json`)。已補上實際存在的 LocalStack 容器(§5.1)。

理由:

- **`tests/` 與 `src/` 並存** — unit 測試貼著 source(import path 短、refactor 同步);integration / e2e 分離(避免共用 helper 散落)
- **`tests/helpers/` 集中可重用 fixture** — 任何重複寫的 setup 應抽到這裡
- 不採「鏡像 `src/` 結構」的設計:過深目錄 + 強制 1:1 對應反而綁手

---

## 4. Vitest 設定

### 4.1 為何用 workspace 而非單一 config

三層測試需求差異大:

| 層 | environment | globalSetup | timeout | 隔離 |
|---|---|---|---|---|
| unit | `node`(無 DOM) | 無 | 5s | 純函式,無 |
| integration | `node` | 起 Postgres + Redis container | 30s | truncate 每 test |
| e2e | `node` | 同上 + MSW server | 60s | truncate 每 test;app 重啟 per file |

單一 config 用 `testTimeout: 60_000` 會讓 unit 變慢、漏跑;單一 `globalSetup` 跑 unit 也會多等 container 啟動。**Vitest workspace** 讓三層各自配置,共用 base config。

### 4.2 結構草案

```ts
// vitest.workspace.ts(草案)
export default [
  {
    test: {
      name: 'unit',
      include: ['src/**/*.test.ts'],
      environment: 'node',
      testTimeout: 5000,
    },
  },
  {
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
      environment: 'node',
      testTimeout: 30_000,
      globalSetup: ['tests/setup/global-setup.ts'],
      setupFiles: ['tests/setup/per-test-setup.ts'],
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },  // 共用容器
      maxConcurrency: 1,                              // 共用 DB:序列化避免 truncate 競爭
    },
  },
  {
    test: {
      name: 'e2e',
      include: ['tests/e2e/**/*.test.ts'],
      environment: 'node',
      testTimeout: 60_000,
      globalSetup: ['tests/setup/global-setup.ts'],
      setupFiles: ['tests/setup/per-test-setup.ts'],
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      maxConcurrency: 1,
    },
  },
]
```

### 4.3 規則

- **unit 不接 globalSetup** — 啟動成本 0,純函式邏輯
- **integration / e2e 共用 container**(`singleFork`),避免每 worker 都啟動一份
- `pool: 'forks'` 而非 `'threads'`:Prisma 的連線 / `process.env.DATABASE_URL` 在 thread 共享會亂套,fork 安全
- `maxConcurrency: 1` 是基於「共享 DB + truncate 策略」的必然推論;若未來改 per-test schema 才能放開

---

## 5. Testcontainers 啟動策略

### 5.1 生命週期

```
vitest run --project=integration
        │
        ▼
tests/setup/global-setup.ts  (v0.3 — 同步實作:透過 project.provide() 傳連線資訊,
                              worker 端用 inject();非 process.env)
  ├── startContainers()  → Postgres 16 + Redis 7 + LocalStack(S3)   # ~3-7s
  ├── project.provide('TEST_DATABASE_URL' / 'TEST_REDIS_HOST' / ...
  │                    'TEST_S3_ENDPOINT' / 'TEST_S3_BUCKET')
  ├── execSync('npx prisma migrate deploy',
  │            { env: { ...process.env, DATABASE_URL: postgres.connectionUri } })  # 顯式覆寫
  └── return teardown 函式
        │
        ▼ teardown(整 suite 結束)
        └── containers.stop()   (Postgres + Redis + LocalStack)
```

> **v0.3 — 同步實作**:除 Postgres / Redis 外,`tests/helpers/container.ts` 亦啟動 **LocalStack**(S3,spec 018),`global-setup.ts:19,30-31` provide `TEST_S3_ENDPOINT` / `TEST_S3_BUCKET`。原本 spec 未記載此容器。

### 5.2 為什麼共用 container 而非 per-file

- container 啟動代價 ~3-7s;若 100 個 test file 各起一份,suite 跑 5-10 分鐘以上
- 共用 container 配合 truncate 隔離,單檔測試 < 200ms,整 suite 30-60s
- 唯一風險:若有測試漏 truncate 殘留 row,下一檔可能受影響 — 由 §6.2 強制 `beforeEach` truncate hook 解決

### 5.3 在 CI 與本地的選擇

| 環境 | 用 testcontainers? | 為什麼 |
|---|---|---|
| 本地 dev | ✅ 必須 | 跨平台一致,不污染本地 Postgres |
| CI(`ci.yml`) | ⚠️ **可選** — 目前 CI 用 GitHub Actions service container | 詳見 §10 |

### 5.4 啟動前置條件

- Docker daemon 需可達(`/var/run/docker.sock` 或 Colima / Rancher Desktop)
- testcontainers 啟動失敗時錯誤訊息需清晰指明「請啟動 Docker」(在 `globalSetup` 加 try/catch + 友善訊息)

---

## 6. 資料隔離

### 6.1 策略:Truncate(呼應 spec 003 §10.3)

每個 test `beforeEach`(v0.3 — 同步實作:實作在 `tests/setup/per-test-setup.ts:43-67`,**用寫死表清單**而非動態查 `pg_tables`;`tests/helpers/db.ts` 目前是 reject stub,尚未接線):

```ts
// tests/setup/per-test-setup.ts(實際)— 寫死 FK-safe 順序,CASCADE 兜底
const TRUNCATE_TABLES = [
  'google_credentials', 'password_credentials', 'accounts',
  'order_lines', 'orders',
  'sale_items', 'donation_projects', 'charity_categories', 'charities', 'categories',
]
const list = TRUNCATE_TABLES.map((t) => `"${t}"`).join(', ')
await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
```

> **v0.3 — 同步實作**:原 §6.1 草案的 `tests/helpers/db.ts` 動態 `truncateAll(prisma)`(查 `pg_tables`)**未落地**——該檔目前 `Promise.reject('not implemented')`。真正 truncate 內嵌於 `per-test-setup.ts` 的 `beforeEach`,表清單寫死(新增 model 需手動補)。

Redis(v0.3 — 同步實作:**單一 `flushdb()`**,非逐 tier `select` + `flushdb`;`per-test-setup.ts:47-58`):

```ts
// tests/setup/per-test-setup.ts(實際)
const client = new Redis({ host, port, lazyConnect: true })
await client.connect()
await client.flushdb()   // 清當前 DB;測試容器單一 DB,不需逐 tier select
await client.quit()
```

### 6.2 規則

- **每個 test 開頭 truncate**(在 `tests/setup/per-test-setup.ts` 的 `beforeEach`),不在 `afterEach`(失敗時 inspect DB state 仍可看到)
- **不用 transaction rollback** 作主策略 — 多筆交易 / nested `$transaction` 的測試會失真(spec 003 §10.3 已決議,本檔重申)
- **不重啟 container**(too slow)
- 失敗時不清理:`vitest --bail=1` 中斷後,container 仍跑,可手動 `docker exec ... psql` inspect

### 6.3 平行測試

- 共用 DB + truncate 策略下,平行多檔會競爭 → §4.2 已設 `maxConcurrency: 1`
- 若效能成瓶頸,改 per-test schema(`CREATE SCHEMA test_${id}` + `SET search_path`)或多 container,本期不做

### 6.4 防漏:Dev DB pointer 不可在 test 進程內留活路(v0.2)

#### 背景

Vitest 啟動時 vite 的 `loadEnv` 會把 `.env` 內容自動載入 `process.env`,包括 `DATABASE_URL`(本機 `.env` 指向 `localhost:5433/jkodonation_dev` 的 dev DB)。本 spec §5.1 規約 `tests/helpers/app.ts` 在 buildApp 時 SCRUB 所有 `KNOWN_CONFIG_KEYS`,但 `DATABASE_URL` **刻意不在 `src/config/schema.ts` 內**(production 從 `DB_*` 組,見 spec 001 §3.2),所以 SCRUB 漏掉它。

#### 漏水後果

`process.env.DATABASE_URL` 殘留指向 dev DB。**只要任一未來 code 走以下路徑**:
1. `new PrismaClient()` 不傳 `datasourceUrl`(預設讀 `schema.prisma` 的 `env("DATABASE_URL")`)
2. `execSync('npx prisma ...')` 不在 `env:` 選項覆寫 `DATABASE_URL`
3. 任何工具走 dotenv-flow 自動 resolve

→ 立刻打 dev DB,跑 `TRUNCATE` / `migrate reset` / `db seed` 就**靜默清空真實開發資料**,且不會有錯誤訊息。

#### 規約

`tests/helpers/app.ts` step 1 額外 scrub:

```ts
delete process.env.DATABASE_URL
delete process.env.DIRECT_URL
```

效果:任何遺漏的 PrismaClient / prisma CLI fallback 路徑會在啟動時 **fail-loud**(「DATABASE_URL is not set」)而非靜默打 dev DB。配合 §5.1 的 `injectRequired` throw,test 進程內**沒有任何路徑能 reach dev DB**。

#### Audit:目前 code 對齊狀況(v0.2 落地)

| 路徑 | 解析來源 | 風險 |
|---|---|---|
| `prismaPlugin`(`src/lib/prisma/plugin.ts`)| `composeDatabaseUrl(config)` from DB_* | ✅ 安全(`tests/helpers/app.ts` step 3 已注入 testcontainer DB_*)|
| `tests/setup/per-test-setup.ts` TRUNCATE | `inject('TEST_DATABASE_URL')` | ✅ testcontainer URI |
| `tests/setup/global-setup.ts:execSync('npx prisma migrate deploy')` | `env: { ...process.env, DATABASE_URL: postgres.connectionUri }` | ✅ 顯式覆寫 |
| `tests/integration/donation-model.test.ts` `new PrismaClient` | `datasourceUrl: inject('TEST_DATABASE_URL')` | ✅ |
| `prisma/seed.ts` `new PrismaClient` | `datasourceUrl: composeDatabaseUrl(config)` | ✅(seed 走 production env;dev seed 是預期清 dev DB 的場景) |

未來新增 test / helper 時若違反上述慣例,§6.4 SCRUB 是最後一道防線。

---

## 7. Fixture 工廠

### 7.1 模式

每個 model 一個 `make<Entity>(overrides?)`:

```ts
// tests/helpers/factories/makeFoo.ts(草案)
let counter = 0

export function makeFoo(
  overrides?: Partial<Prisma.FooCreateInput>
): Prisma.FooCreateInput {
  counter += 1
  return {
    name: `foo-${counter}`,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}
```

### 7.2 規則

- **回傳 `CreateInput` 而非已 persist 的 row**:呼叫方決定要不要 `prisma.foo.create({ data: makeFoo() })`,或直接餵 service 函式
- **不共用 counter / 隨機 ID 與 dev seed**:測試 fixture 與 `prisma/seed.ts` 完全隔離
- 跨 model 的 fixture 用 composition:`makeBar({ foo: { create: makeFoo() } })`,**不**寫 `setupFullStack()` 巨型 helper
- 預設值要**最小化** + 決定性(時間用固定字串、不用 `new Date()`)
- counter 在 `per-test-setup` 內 reset(讓單檔測試斷言可預期 ID)

---

## 8. 外部服務 mock 邊界

### 8.1 可 mock(在我們控制邊界外)

| 對象 | 工具 | 用法 |
|---|---|---|
| Google OAuth `/token`、JWKS、OIDC discovery | `msw` | 啟在 `globalSetup`,handler 集中於 `tests/helpers/msw.ts` |
| 任意第三方 webhook / outbound HTTP | `msw` | 同上 |
| 時間 | `vi.useFakeTimers({ shouldAdvanceTime: true })` | per test 開關 |
| 隨機 ID / nonce | 由 application 注入 `idGenerator`,測試傳固定值 | 不 monkey-patch `crypto.randomUUID` |

### 8.2 不可 mock(內部基礎建設)

- **Prisma** — 真 PostgreSQL container(`CLAUDE.md` 鐵則)
- **Redis** — 真 Redis container(`CLAUDE.md` 鐵則)
- **Fastify route handler 自身** — 用 `fastify.inject()` 跑真實 lifecycle
- **`@fastify/env` 載入** — 測試環境變數由 `tests/helpers/app.ts` 注入,不 mock loader

### 8.3 MSW 啟動

> **v0.3 — 同步實作**:MSW **不**在 `global-setup.ts` 起全域 server(該檔只起容器 + migrate,無 `setupServer`)。改為**per-test 工廠** `createGoogleMsw()`(`tests/helpers/msw.ts:66`):每個需要 OAuth 的 integration test 自行 allocate 一組 RSA key + JWKS + handlers,並在 test 內 `setupServer(...setup.handlers).listen()`。`googleHandlers` 已 **deprecated 為空陣列**(`msw.ts:124`),保留只為舊 import 不炸。

```ts
// 實際用法(tests/integration/*.test.ts 內)
import { createGoogleMsw } from '../helpers/msw'

const google = createGoogleMsw()
const server = setupServer(...google.handlers)
server.listen({ onUnhandledRequest: 'error' })  // unhandled = test bug
google.enqueueTokenResponse(google.signIdToken({ sub, email, nonce, aud }))
```

- `onUnhandledRequest: 'error'` 強制每個外呼都要有 handler,避免不小心打到真 Google API
- 各 test 自行 `server.resetHandlers()` / `close()`,per-test 隔離不共用全域 handler

---

## 9. `npm` Scripts

```jsonc
// package.json scripts(草案)
{
  "test":             "vitest run",
  "test:watch":       "vitest",
  "test:unit":        "vitest run --project=unit",
  "test:integration": "vitest run --project=integration",
  "test:e2e":         "vitest run --project=e2e",
  "test:coverage":    "vitest run --coverage",
  "test:ui":          "vitest --ui"
}
```

對應 `CLAUDE.md`「例行檢查」:

| 場景 | 指令 |
|---|---|
| 開發中 | `npm run test:watch` |
| commit 前 | `npm run typecheck && npm test` |
| PR 前 | `npm run test:integration` |

---

## 10. CI 整合

### 10.1 現況:GitHub Actions service container

`backend/.github/workflows/ci.yml` 已用 `services: postgres / redis` 起 container,而非 testcontainers。

### 10.2 為何「本地 testcontainers,CI service container」可接受

| 角度 | 影響 |
|---|---|
| 啟動成本 | service container 由 runner 啟動,比 testcontainers 略快(無 docker-in-docker overhead) |
| 設定重複 | container image / port 寫兩次(一份 `ci.yml`,一份 testcontainers helper);**接受成本**,service container 設定極少改 |
| 行為一致性 | 兩邊都用 `postgres:16` / `redis:7`,版本對齊即可 |

### 10.3 切換點

若未來出現以下任一,改為 CI 也跑 testcontainers:

- service container 與本地 image 版本歧異難維護
- 需要多 Postgres 版本矩陣測試(testcontainers 動態指定 image 較簡單)
- 需要在單一 job 內起多份隔離 DB(service container 一 job 一份)

### 10.4 環境變數對齊

CI 與 `tests/setup/global-setup.ts` 都需注入 spec 001 §4.3 必填項。`ci.yml`(已於本日同步修正)已對齊;testcontainers helper 應產生**同名變數**,讓 `tests/helpers/app.ts` 的 `buildApp()` 在兩處行為一致。

---

## 11. 覆蓋率政策

呼應 `CLAUDE.md`「覆蓋率立場」:

- `npm run test:coverage` 印 `text` + `html`(`coverage/` 目錄,已在 `.gitignore`)
- **不設門檻**;CI 不 fail
- 報告作為 reviewer 輔助,不作為 PR 門禁
- 例外:若某模組明確規劃要高覆蓋(例:`src/lib/errors/`),於該模組 README 說明預期,不寫到全域 config

---

## 12. 觀測與除錯

| 場景 | 做法 |
|---|---|
| Test 失敗時 inspect DB | container 不 stop;`docker ps` 找 ID,`psql` 連入查 |
| Redis 殘留 | 同上,`redis-cli -p <mapped> KEYS '*'` |
| log noise | 測試環境 `LOG_LEVEL=warn`(由 `globalSetup` 注入);fail 時 log 自動曝出 |
| flaky 排查 | `vitest run --repeat=10 <file>` |
| 時序依賴 | `vitest run --shuffle` 隨機順序,固定 flaky |

---

## 13. 開放問題

- **`vitest --shuffle` 是否預設開**:可早期抓出測試順序依賴,但會讓 flaky 看起來「忽紅忽綠」。暫定**手動觸發**,正式 CI 不開
- **多 Postgres / Redis 版本矩陣**:目前單版本即可,future work
- **與 `frontend/` 共用 MSW handler**:Google OAuth handler 兩邊可能各寫一份。短期接受;若重複明顯則抽到 monorepo 共享(目前兩 repo 獨立,不便)

---

## 14. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-13 | 初版 |
| 0.3 | 2026-07-07 | **同步實作**:§3 檔案結構移除不存在項(`vitest.config.ts`、`tests/helpers/factories/`、`tests/tsconfig.json`),補 LocalStack(S3)容器;§5.1 生命週期改為 `project.provide()` + inject()、啟動 Postgres/Redis/LocalStack;§6.1 truncate 實作在 `per-test-setup.ts` 用**寫死表清單**(`db.ts` 仍為 reject stub),Redis 為**單一 flushdb** 非逐 tier;§8.3 MSW 改 per-test `createGoogleMsw()` 工廠(非 global-setup 全域 server),`googleHandlers` 已 deprecated 空陣列 |
| 0.2 | 2026-06-15 | §6.4 新增「Dev DB pointer 不可在 test 進程內留活路」規約 — `tests/helpers/app.ts` step 1 額外 `delete process.env.DATABASE_URL / DIRECT_URL`。理由:`src/config/schema.ts` 刻意把 `DATABASE_URL` 留在 schema 外(production 從 DB_* 組),於是 §5.1 的 SCRUB 漏掉它,vite `loadEnv` 自動載 `.env` 後 `process.env.DATABASE_URL` 殘留指向 dev DB。本版加 belt-and-suspenders 防漏,目前 code 已對齊(audit 表)|
