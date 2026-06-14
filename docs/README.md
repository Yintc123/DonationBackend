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
    ├── decisions/           # backend 內部 ADR
    ├── specs/               # 模組規格書(契約 — 「what / why」)
    └── guides/              # 實作 / 維運手冊(操作 — 「how」)
```

> **三種文件的差別**:
> - **ADR / spec** 定義契約與設計(改動需審查、有版本控管)
> - **Guide** 寫實際操作指令、工作流、排查路徑(隨技術 stack 演進更新即可,無版本枷鎖)

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
| 001 | Figma MCP | 採社群 `figma-developer-mcp`,Viewer 權限可讀(專案層,與 backend 無直接耦合) |
| 002 | Backend 框架 | Fastify + BFF 分層;JWT stateless |
| 003 | 資料庫 | PostgreSQL 16(對齊 CI service container) |
| 004 | Auth token 策略 | Access 3h + Refresh 30d,Redis only(AOF),rotation + replay detection |
| 005 | BFF session — iron-session | BFF 只 seal `sessionId`;影響 backend 的 trust 邊界(spec 007 §2) |
| 006 | BFF session — Redis store | BFF Redis-backed session;backend 不感知,但 BFF→backend 的 Bearer JWT 與此 session 綁定 |
| 007 | ORM — Prisma vs TypeORM | 正式採用 Prisma 5.x;補上 ADR 002/003 的隱含前提(spec 003 落實) |

> ADR 005 / 006 雖屬 BFF(frontend)決策,但 backend 的 BFF 信任假設(spec 007 §2、spec 012 trusted proxy)由其推導,列入此表供查閱。frontend 自有 ADR 序列在 `frontend/docs/decisions/`。

### Backend-local ADR(`decisions/`)

跟 backend 內部結構 / 資料模型有關、不影響其他子專案的決策放這裡。

| # | 主題 | 摘要 |
|---|---|---|
| 001 | [捐款項目對 Charity 關聯](decisions/001-donation-item-relations.md) | 1:N + NOT NULL FK + onDelete Restrict |
| 002 | [Charity 分類資料模型](decisions/002-charity-category-model.md) | (見檔) |
| 003 | [Fastify route 組織慣例](decisions/003-fastify-route-organization.md) | business → `src/routes/`、infra plugin → `src/lib/<concern>/plugin.ts`;解釋為何健康檢查 route 不在 routes/ |

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
| **013** | [測試基礎建設](specs/013-test-infrastructure.md) | v0.1 | vitest workspace 三 project;testcontainers 共用容器 + truncate 隔離;factory pattern;MSW 攔截外部 HTTP |
| **014** | [部署 / Container](specs/014-deployment-container.md) | v0.1 | Multi-stage Dockerfile(alpine、non-root);BUILD_* metadata 注入;SIGTERM → readiness gate → drain;K8s 三 probe 接 spec 011 |

---

## 4. Guides(實作 / 維運手冊)

不是契約,也不是決策 — 是「怎麼操作 / 工作流 / 排查」的活文件。新人 onboarding 從這裡開始。

| 主題 | 摘要 |
|---|---|
| [Prisma 工作流](guides/prisma-workflow.md) | Model 在哪、改 schema 怎麼同步、migration 流程、混合手寫 SQL、dev → CI → prod 傳播、反 pattern、排查 |

---

## 5. 依賴關係圖

```
  ADR 層 ─────────────────────────────────────────────────────────────
       002 Fastify    003 PostgreSQL    004 Auth token    007 Prisma
          │                │                  │              │
          ▼                ▼                  ▼              ▼
  Spec 層 ─────────────────────────────────────────────────────────────
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
    011 Health Check ◀──── 014 部署 / Container(probe 接線、graceful shutdown)
        │
        └───── 013 測試基礎建設(覆蓋所有上層 spec 的測試樣板)
```

- ADR 是 spec 的源頭;ADR 改動需檢視所有引用該 ADR 的 spec
- 上層 spec 引用下層;下層改動時 reviewer 應檢查上層是否需同步
- 環境設定(001)、Logger(004)、Errors(005)為**橫切**,其他 spec 多會引用
- 013(測試)與 014(部署)為**運維橫切**:013 覆蓋所有 spec 的測試需求,014 落地 spec 011 的 probe 與 spec 003/006 的 client lifecycle

---

## 6. 單一事實來源(避免散落)

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

## 7. 進入開發前的必補項

| 缺項 | 影響 | 狀態 |
|---|---|---|
| 資料模型 spec(承 spec 007 §10.7 / spec 003 §2.2) | 無法落具體 schema,所有 auth 與業務實作卡住 | **業務層,本期不展開**;基礎建設可獨立完成 |
| 部署 / Container spec | Dockerfile、graceful shutdown 對齊 spec 011 §9、BUILD_GIT_SHA 注入 | ✅ 已補 spec 014 |
| 測試基礎建設 spec | TDD 鐵則已在 `CLAUDE.md`,但 fixture pattern / testcontainers helper / integration setup 無 spec → 風格易飄 | ✅ 已補 spec 013 |

---

## 8. 版本與變更紀錄

每份 spec 末尾皆有「變更紀錄」表。重大變動時:

- 升 minor 版本(0.1 → 0.2 → 0.3)
- 該版本在變更紀錄寫明**影響的 §**與**理由**
- 引用該 spec 的下游 spec 由 reviewer 確認是否要連帶升版

---

## 9. 維護規約

- 文件用**繁體中文**(承專案 `CLAUDE.md`);程式碼識別字、commit message 用英文
- spec 內**禁業務領域詞彙**(`donation`、`balance` 等);例外詞:`amount`(金額型別)、`load balancer`(術語)
- 新增 spec 編號連續,不留洞
- 跨 spec 引用使用相對連結與 §(章節)號,例:`spec 005 §4.2`
