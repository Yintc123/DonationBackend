# JKODonation Backend

2026 全端面試作業 — Backend API。Fastify + TypeScript + Prisma + PostgreSQL + Redis + S3。

> **文件導覽**:本檔是入口(怎麼跑起來、API 速覽)。設計細節在 [`docs/README.md`](docs/README.md)。

---

## 快速啟動(從 git clone 到能 curl)

需求:`node >= 20`、`docker`、`npm`、`jq`(seed 用)、`aws` CLI(LocalStack bootstrap 用,可選)。

```bash
# 1. 起 PostgreSQL + Redis + LocalStack(三個容器)
cd ../infra && cp .env.example .env  # 填密碼;或直接用 example 的預設
docker compose up -d

# 2. 設定 backend env
cd ../backend && cp .env.example .env
#    本機開發務必把 S3_ENDPOINT 指向 LocalStack,否則 seed 會打向真實 AWS:
#      S3_ENDPOINT="http://localhost:4566"   (.env 內取消該行註解)
#    其餘變數用 .env.example 預設值即可

# 3. LocalStack S3 bucket bootstrap(idempotent — 重跑沒事)
./scripts/bootstrap-localstack.sh

# 4. 套 migration + seed(16 分類 + 30+ 公益團體,每團體多個募款專案 / 義賣商品 + 圖)
npm install
npm run prisma:migrate:dev   # 套 5 個 donation domain table + pg_trgm
npm run prisma:seed          # 寫資料 + 上傳 placeholder 圖到 LocalStack

# 5. 跑起來
npm run dev                  # tsx watch, port 3001
```

### 驗證跑得起來

```bash
# Health
curl http://localhost:3001/health/live      | jq    # liveness
curl http://localhost:3001/health/ready     | jq    # readiness(含 DB + Redis 探針)
curl http://localhost:3001/health/storage   | jq    # S3 探針

# 三個 tab 的列表(對應 Figma)。user-facing API 前綴為 /user/v{N}(spec 023)
curl 'http://localhost:3001/user/v1/donation/charities?limit=3'        | jq
curl 'http://localhost:3001/user/v1/donation/donation-projects?limit=3'| jq
curl 'http://localhost:3001/user/v1/donation/sale-items?limit=3'       | jq

# 中文搜尋
curl 'http://localhost:3001/user/v1/donation/charities?q=流浪動物' | jq '.items[].name'

# 英文搜尋 + locale 切換
curl -H 'Accept-Language: en' \
     'http://localhost:3001/user/v1/donation/charities?q=stray' | jq '.items[].name'

# Category 字典
curl http://localhost:3001/user/v1/donation/categories | jq '.items | length'   # 16

# 分類 filter(子表繼承)
curl 'http://localhost:3001/user/v1/donation/donation-projects?category=animal_protection' | jq

# Detail(用上面拿到的 id)
curl http://localhost:3001/user/v1/donation/charities/<uuid> | jq
```

---

## 技術棧

| 領域 | 選用 | 規格 |
|---|---|---|
| Runtime | Node.js 20+ | — |
| Framework | [Fastify](https://fastify.dev/) 5.x | [專案 ADR 002](../docs/decisions/002-backend-framework.md) |
| Language | TypeScript 5.7 (strict) | — |
| ORM | [Prisma](https://www.prisma.io/) 5.22 | [專案 ADR 007](../docs/decisions/007-orm-prisma.md) |
| Database | PostgreSQL 16 + `pg_trgm` 擴充 | [專案 ADR 003](../docs/decisions/003-database-postgresql.md) |
| Cache / Rate-limit | Redis 7 (`ioredis`) | [spec 006](docs/specs/006-redis-module.md) |
| Object Storage | AWS S3(本地 LocalStack) | [spec 018](docs/specs/018-storage-module.md) |
| Auth | JWT stateless + Google OIDC | [spec 007](docs/specs/007-auth-flow-google-oidc.md) / [spec 008](docs/specs/008-auth-flow-password.md) |
| Schema | TypeBox(編譯期型別 + 執行期 ajv) | — |
| Logging | pino + redaction | [spec 004](docs/specs/004-logger-module.md) |
| Testing | vitest + testcontainers(PostgreSQL/Redis/LocalStack) | [spec 013](docs/specs/013-test-infrastructure.md) |
| Container | Multi-stage alpine,non-root | [spec 014](docs/specs/014-deployment-container.md) |

---

## 架構

服務本身是 **JWT stateless API**,不持 session。Browser 端 session 由 Next.js BFF 管理。

```
Browser ──(session cookie)──> Next.js BFF ──(JWT Bearer)──> Fastify API ──┬──> PostgreSQL
                                                                          ├──> Redis
                                                                          └──> S3 / CloudFront
```

詳細層次見 [backend ADR 005](docs/decisions/005-source-tree-layer-convention.md)。

### 程式碼分層

```
src/
├── routes/        ← HTTP handler(薄,只解 query / 呼 domain / 回 reply)
├── schemas/       ← TypeBox shapes(query / response 的 wire 型別)
├── domain/        ← 業務規則 + Prisma I/O(不知道 HTTP)
│   ├── lifecycle/      whereLive / whereLiveWithParent helpers(ADR 006)
│   ├── donation-item/  Charity / Project / SaleItem 的 list / detail / write 服務
│   ├── order/          捐款訂單 domain(建立 / 查詢 / 狀態機 + §7 invariant,spec 021/022)
│   ├── category/       Category 字典
│   └── uploads/        Upload presign 的 entity 存在檢查
├── services/      ← 讀取快取層(cached-* 包在 domain 讀取外,spec 019)
├── lib/           ← 跨 feature infra(不知道 entity)
│   ├── s3/             AWS SDK + presigned URL + objectUrl
│   ├── i18n/           Accept-Language 解析 + locale fallback
│   ├── cursor/         3-segment opaque pagination cursor
│   ├── cache/          donation 快取失效枚舉(withCache / invalidate)
│   ├── prisma/         PrismaClient 生命週期 plugin
│   ├── redis/          ioredis + 分區 key prefix
│   ├── errors/         AppError + RFC 7807 errorHandler + Prisma 錯誤映射
│   ├── health/         readinessGate + probe + memoizeProbe
│   ├── rate-limit/     sliding window + Lua + multi-layer
│   ├── auth/           JWT 簽 / 驗 + password
│   ├── auth-google/    OAuth2 + OIDC + PKCE
│   ├── logger/         pino + child logger + redaction
│   ├── http/           reply decorators + 分頁 envelope + API 版本
│   ├── openapi/        OpenAPI 文件產生
│   ├── db/             discrete DB_* → DATABASE_URL composer
│   ├── clock.ts        可注入 clock seam(測試決定性)
│   └── security/       helmet + cors
├── config/        ← env 解析(spec 001)+ post-validate cross-field 守門
├── app.ts         ← Fastify 組裝(plugin 註冊順序)
└── server.ts      ← Node entry(SIGTERM 串接 readinessGate)
```

---

## API endpoint 速覽

對應 [Figma](https://www.figma.com/design/0kx2Ne2rvndhfVr3uVUwad/)《所有捐款項目》三個 tab。

> API surface 分三塊(spec 023):`/user/v{N}/*` 公開讀取、`/cms/*` admin 寫入(過 `requireAdmin`)、`/auth/*` 認證(不版本化)。目前 user 版本為 `v1`。

### Donation public — `/user/v1`(spec 016 / spec 017)

| Method | Path | 用途 |
|---|---|---|
| GET | `/user/v1/donation/charities` | 公益團體列表(`?q=` `?category=` `?cursor=` `?limit=`)|
| GET | `/user/v1/donation/charities/:id` | 公益團體詳情 |
| GET | `/user/v1/donation/donation-projects` | 捐款專案列表(同上 +`?charityId=`)|
| GET | `/user/v1/donation/donation-projects/:id` | 捐款專案詳情 |
| GET | `/user/v1/donation/sale-items` | 義賣商品列表 |
| GET | `/user/v1/donation/sale-items/:id` | 義賣商品詳情 |
| GET | `/user/v1/donation/categories` | 分類字典(16 筆,public cache 5min) |

### CMS admin — `/cms`(需 admin JWT,spec 018 / 020 / 022)

| Method | Path | 用途 |
|---|---|---|
| POST | `/cms/uploads/presign` | S3 pre-signed PUT URL(admin 寫入用)|

> 註:CMS 另有 charity / project / sale-item / category 的寫入端點與 `/cms/orders` 訂單管理(spec 020 / 022),完整清單見各 spec。

**公開讀取特性**:
- Cursor 分頁(3-segment opaque token)+ `hasMore` flag
- `Accept-Language: zh-TW / en`(預設 zh-TW;英文缺翻譯時 fallback;`Vary: Accept-Language`)
- Lifecycle filter + cascading visibility(Charity 合約過期 → 子表自動消失;續約自動恢復)
- ORDER BY `display_order ASC, created_at DESC, id DESC`(admin pin 機制)

### Auth(spec 007 / 008)

| Method | Path | 用途 |
|---|---|---|
| POST | `/auth/register` | email+password 註冊 |
| POST | `/auth/login` | email+password 登入 |
| POST | `/auth/password/change` | 改密碼(需 access JWT) |
| POST | `/auth/password/set` | OAuth 用戶加密碼 |
| POST | `/auth/google/authorize-init` | 啟動 Google OIDC flow(產 state / nonce / PKCE) |
| POST | `/auth/google/exchange` | OAuth code → JWT(BFF 呼叫) |

### Health(spec 011)

| Method | Path | 用途 |
|---|---|---|
| GET | `/health/live` | K8s liveness(不查依賴) |
| GET | `/health/ready` | K8s readiness(DB + Redis probe,1s coalesce) |
| GET | `/health/startup` | K8s startup |
| GET | `/health/storage` | S3 connectivity(獨立非 readiness) |

---

## 環境變數

完整清單見 [`.env.example`](.env.example) — 註解中分組說明每個變數。重點:

- **DB / Redis**:discrete `DB_HOST` / `DB_PORT` / ... + `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD`(對稱命名,application 層自組 connection URL)
- **JWT**:`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` 都 ≥ 32 字元且**必須不同**(startup 守門)
- **S3**:dev 用 LocalStack(`S3_ENDPOINT=http://localhost:4566`);prod 把 endpoint 留空走真實 AWS,**且** `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 必須留空(走 ECS task role,startup 強制守門)
- **CORS / Rate-limit / HSTS** 等其他模組亦同。詳見 [spec 001 §3](docs/specs/001-environment-config.md)

---

## 測試

```bash
npm test                  # 整套(unit + integration + e2e),88 個測試檔
npm run test:unit         # 純函式單元測試
npm run test:integration  # 真實 testcontainer(PostgreSQL + Redis + LocalStack)
npm run test:e2e          # full HTTP flow
npm run test:watch        # vitest watch mode
npm run test:coverage     # coverage report
```

**測試哲學**(摘自 [backend `CLAUDE.md`](CLAUDE.md)):

- **TDD 鐵則** — 沒有失敗的測試就不寫產品碼。Red → Green → Refactor。
- **不 mock infra** — Prisma / Redis 都跑真實 testcontainer(呼應 ADR 007 「型別端到端」原則)。
- **可 mock 外部 HTTP** — Google OAuth、第三方 webhook 走 `msw`。
- **覆蓋率不追百分比** — 重點是關鍵路徑(auth / 業務 invariant / 錯誤分支)。

---

## 常用 npm scripts

| 指令 | 用途 |
|---|---|
| `npm run dev` | tsx watch(port 3001) |
| `npm run build` | tsc → `dist/` |
| `npm run start` | node dist/server.js(prod 模式) |
| `npm run typecheck` | tsc --noEmit |
| `npm run lint` | eslint . |
| `npm run lint:fix` | eslint --fix |
| `npm run format` | prettier --write |
| `npm run prisma:generate` | 重生 TS client(改 schema 後) |
| `npm run prisma:migrate:dev` | 套 migration + 重生 client |
| `npm run prisma:migrate:deploy` | 只套 migration(prod / CI 用) |
| `npm run prisma:seed` | 跑 `prisma/seed.ts` |

> Prisma workflow 詳見 [`docs/guides/prisma-workflow.md`](docs/guides/prisma-workflow.md)。

---

## 文件導覽

| 類別 | 位置 | 適合查 |
|---|---|---|
| **ADR(架構決策)** | [`docs/decisions/`](docs/decisions/) + 專案根 `docs/decisions/` | 「為什麼這樣設計?」 |
| **Spec(模組規格)** | [`docs/specs/`](docs/specs/) | 「這個模組的 contract 是?」 |
| **Guide(操作手冊)** | [`docs/guides/`](docs/guides/) | 「怎麼做這件事?」 |
| **文件總導覽** | [`docs/README.md`](docs/README.md) | 全部清單 + 依賴關係圖 + 閱讀順序 |
| **AI 協作約束** | [`CLAUDE.md`](CLAUDE.md) | TDD 鐵則、Claude 行為要求 |

### 重點 ADR / spec(評審 deep-dive 入口)

| 文件 | 重點 |
|---|---|
| [spec 015 — Donation data model](docs/specs/015-charity-data-model.md) | 5 個 Prisma model + lifecycle + cascade FK + `pg_trgm` 搜尋 |
| [spec 016 — List API](docs/specs/016-charity-list-api.md) | 三 tab 共用 contract + cursor + i18n + 子表繼承 |
| [spec 017 — Detail API](docs/specs/017-detail-apis.md) | Detail shape + locale ETag + cascading visibility |
| [spec 018 — S3 storage](docs/specs/018-storage-module.md) | Pre-signed PUT + public read + key namespace + LocalStack dev |
| [ADR 005 — Source tree layer convention](docs/decisions/005-source-tree-layer-convention.md) | `lib / domain / routes / schemas` 四層 + 依賴方向 |
| [ADR 006 — Lifecycle + cascading visibility](docs/decisions/006-lifecycle-fields-and-cascading-visibility.md) | `whereLive` 四條件 + 子表自動隨 parent 過期 |

---

## AI 使用聲明

本專案開發過程使用 [Claude Code](https://claude.com/claude-code) 輔助。

- **AI 角色**:技術選型討論、ADR 撰寫、骨架生成、code review、按規格 TDD 實作
- **人工角色**:需求理解、架構決策、實作驗收、安全審查、跨 spec 一致性把關
- **對話紀錄**:保存於專案根目錄 `docs/prompts/`(raw + 精選版)
