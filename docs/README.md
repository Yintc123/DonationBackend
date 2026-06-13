# Backend 文件導覽

本目錄收錄 backend 服務的設計文件。專案級 ADR 在根目錄 `../../docs/decisions/`。

> **首次閱讀建議順序**:`../../docs/decisions/002` → `../../docs/decisions/004` → `specs/001` → `specs/005` → `specs/007` → 其他 spec 依需要查閱。

---

## 1. 文件結構

```
backend/
├── CLAUDE.md                # 給 Claude / AI 的協作約束(TDD 鐵則)
├── README.md                # 給人的入口(技術棧、跑起來、AI 聲明)
└── docs/
    ├── README.md            # 本檔:文件導覽
    └── specs/               # 模組規格書
```

專案級文件在 monorepo 根:

```
docs/
├── decisions/               # ADR
├── prompts/                 # 與 AI 對話的精選紀錄(作業要求)
└── ... (略)
```

---

## 2. ADR(根目錄 `docs/decisions/`)

| # | 主題 | 摘要 |
|---|---|---|
| 001 | Figma MCP | 採社群 `figma-developer-mcp`,Viewer 權限可讀 |
| 002 | Backend 框架 | Fastify + BFF 分層;JWT stateless |
| 003 | 資料庫 | PostgreSQL 16(對齊 CI service container) |
| 004 | Auth token 策略 | Access 3h + Refresh 30d,Redis only(AOF),rotation + replay detection |

---

## 3. Spec 一覽

| # | 主題 | 版本 | 關鍵決策 |
|---|---|---|---|
| **001** | [環境設定](specs/001-environment-config.md) | v0.3 | `@fastify/env` + JSON Schema fail-fast;DB 多參數拆分 + dotenv-expand 衍生 `DATABASE_URL`;**單一事實來源**(env vars schema 集中於此) |
| **002** | [`.env.example` 模板](specs/002-env-example-template.md) | v0.3 | 與 spec 001 雙向綁定;格式規範與目標草案 |
| **003** | [ORM 模組](specs/003-orm-module.md) | v0.2 | Prisma + Fastify plugin;`Decimal` 處理金額;`testcontainers` 不 mock;命名範例已中性化 |
| **004** | [Logger 模組](specs/004-logger-module.md) | v0.2 | `pino` 結構化;child logger per 模組;**event 字典單一事實來源**(§9.3,50+ events) |
| **005** | [錯誤處理](specs/005-error-handling.md) | v0.2 | Joyent operational vs programmer;RFC 7807 Problem Details;Fastify 單一 `setErrorHandler`;**error code 字典單一事實來源**(§4.2,40+ codes);health 端點例外 RFC 7807 |
| **006** | [Redis 模組](specs/006-redis-module.md) | v0.1 | `ioredis` + `@fastify/redis`;**tier 分區治理**(cache / auth / rate / lock / job);所有 key 必 TTL;prod AOF 必開 |
| **007** | [Auth — Identity + Google OIDC](specs/007-auth-flow-google-oidc.md) | v0.2 | Authorization Code + PKCE + OIDC;Account ↔ Credential 抽象;嚴格手動連結(無自動 link);ID Token 8 項必驗 |
| **008** | [Auth — Email + Password](specs/008-auth-flow-password.md) | v0.1 | Argon2id(OWASP 2025 基準);NIST 800-63B 風格密碼規則;三道列舉防護 |
| **009** | [API Response 與 HTTP Status](specs/009-api-response-and-http-status.md) | v0.1 | 無 envelope;cursor-based 分頁;`Idempotency-Key`;ETag-driven caching |
| **010** | [Rate-limit](specs/010-rate-limit-module.md) | v0.2 | Sliding window counter(Lua);4 層同時套用(global / route-ip / route-user / purpose);失敗關閉 |
| **011** | [Health check](specs/011-health-check.md) | v0.1 | K8s liveness / readiness / startup 嚴格區分;cascade-failure 防範;graceful shutdown 用 readiness gate |
| **012** | [CORS / Security Headers](specs/012-cors-and-security-headers.md) | v0.1 | helmet + 三處升級;**禁 `trustProxy: true`**(`X-Forwarded-For` 偽造攻擊面);HSTS 365d |

---

## 4. 依賴關係圖

```
                        001 環境設定
                            │
                ┌───────────┼───────────┐
                │           │           │
            003 ORM      006 Redis    012 CORS
                │           │           │
                └───┬───────┘           │
                    │                   │
                004 Logger          010 Rate-limit
                    │                   │
                005 Errors              │
                    │                   │
        ┌───────────┴───────────────────┘
        │
    007 Auth + Identity ────┐
        │                   ▼
        ▼               008 Auth — 帳密
    009 API Response
        │
    011 Health Check
```

- 上層引用下層;下層改動時 reviewer 應檢查上層是否需同步
- 環境設定(001)、Logger(004)、Errors(005)為**橫切**,其他 spec 多會引用

---

## 5. 單一事實來源(避免散落)

當資訊在多 spec 出現時,以下為**權威來源**;其他 spec 引用而非複製:

| 領域 | 權威 spec 章節 |
|---|---|
| **環境變數** | spec 001 §3 / §4.3 schema |
| **Event 字典** | spec 004 §9.3 |
| **Error code 字典** | spec 005 §4.2 |
| **HTTP 回應 shape / status / headers** | spec 009 |
| **Redis tier 治理** | spec 006 §5 |
| **Account ↔ Credential 識別模型** | spec 007 §10 |

擴充其中之一**必須**在權威 spec 同步更新(由 reviewer 把關)。

---

## 6. 進入開發前的必補項

| 缺項 | 影響 |
|---|---|
| 資料模型 spec(承 spec 007 §10.7 / spec 003 §2.2) | 無法落具體 schema,所有 auth 與業務實作卡住 |
| 部署 / Container spec | Dockerfile、graceful shutdown 對齊 spec 011 §9、BUILD_GIT_SHA 注入無共識 |
| 測試基礎建設 spec | TDD 鐵則已在 `CLAUDE.md`,但 fixture pattern / testcontainers helper / integration setup 無 spec → 風格易飄 |

---

## 7. 版本與變更紀錄

每份 spec 末尾皆有「變更紀錄」表。重大變動時:

- 升 minor 版本(0.1 → 0.2 → 0.3)
- 該版本在變更紀錄寫明**影響的 §**與**理由**
- 引用該 spec 的下游 spec 由 reviewer 確認是否要連帶升版

---

## 8. 維護規約

- 文件用**繁體中文**(承專案 `CLAUDE.md`);程式碼識別字、commit message 用英文
- spec 內**禁業務領域詞彙**(`donation`、`balance` 等);例外詞:`amount`(金額型別)、`load balancer`(術語)
- 新增 spec 編號連續,不留洞
- 跨 spec 引用使用相對連結與 §(章節)號,例:`spec 005 §4.2`
