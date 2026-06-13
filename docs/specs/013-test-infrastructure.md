# Spec 013:測試基礎建設(Test Infrastructure)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.1 |
| 日期 | 2026-06-13 |
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
├── vitest.config.ts             # base config(被 workspace 各 project 繼承)
├── tests/
│   ├── helpers/
│   │   ├── container.ts         # PostgreSQL / Redis testcontainers 啟動
│   │   ├── app.ts               # buildApp() 工廠,共用 plugin 註冊
│   │   ├── db.ts                # truncate / migrate helper
│   │   ├── factories/           # make<Entity>(overrides) 工廠
│   │   └── msw.ts               # MSW server / handlers
│   ├── integration/             # route + Prisma + Redis 真容器
│   ├── e2e/                     # 多 route 串接、OAuth callback 用 MSW
│   ├── setup/
│   │   ├── global-setup.ts      # 整 suite 啟動 container、migrate
│   │   └── per-test-setup.ts    # MSW reset、fake timer reset、truncate
│   └── tsconfig.json            # 測試專用 tsconfig(放寬 noUnused* 等)
└── src/
    └── **/*.test.ts             # unit:與 source 同檔名 / 同目錄
```

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
tests/setup/global-setup.ts
  ├── new PostgreSqlContainer('postgres:16').start()       # ~2-5s
  ├── new GenericContainer('redis:7-alpine')
  │     .withExposedPorts(6379).start()                    # ~1-2s
  ├── 注入 process.env:DB_HOST / DB_PORT / ... / REDIS_URL
  ├── 由 §6 helper 組 DATABASE_URL → process.env.DATABASE_URL
  ├── execSync('npx prisma migrate deploy')                # ~1-2s
  └── return teardown 函式
        │
        ▼ teardown(整 suite 結束)
        ├── pgContainer.stop()
        └── redisContainer.stop()
```

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

每個 test `beforeEach`:

```ts
// tests/helpers/db.ts(草案)
export async function truncateAll(prisma: PrismaClient) {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `
  if (tables.length === 0) return
  const list = tables.map(t => `"${t.tablename}"`).join(', ')
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`
  )
}
```

Redis:

```ts
// 對應 spec 006 的 tier db 編號,逐一 FLUSHDB
for (const db of REDIS_DB_NUMBERS) {
  await redis.select(db)
  await redis.flushdb()
}
```

### 6.2 規則

- **每個 test 開頭 truncate**(在 `tests/setup/per-test-setup.ts` 的 `beforeEach`),不在 `afterEach`(失敗時 inspect DB state 仍可看到)
- **不用 transaction rollback** 作主策略 — 多筆交易 / nested `$transaction` 的測試會失真(spec 003 §10.3 已決議,本檔重申)
- **不重啟 container**(too slow)
- 失敗時不清理:`vitest --bail=1` 中斷後,container 仍跑,可手動 `docker exec ... psql` inspect

### 6.3 平行測試

- 共用 DB + truncate 策略下,平行多檔會競爭 → §4.2 已設 `maxConcurrency: 1`
- 若效能成瓶頸,改 per-test schema(`CREATE SCHEMA test_${id}` + `SET search_path`)或多 container,本期不做

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

```ts
// tests/setup/global-setup.ts(草案,片段)
import { setupServer } from 'msw/node'
import { googleHandlers } from '../helpers/msw'

const mswServer = setupServer(...googleHandlers)
mswServer.listen({ onUnhandledRequest: 'error' })  // unhandled = test bug
```

- `onUnhandledRequest: 'error'` 強制每個外呼都要有 handler,避免不小心打到真 Google API
- `per-test-setup` 內 `mswServer.resetHandlers()` 清掉測試內 override

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
