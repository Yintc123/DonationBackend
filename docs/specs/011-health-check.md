# Spec 011:Health Check 與 Readiness Probe

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.1 |
| 日期 | 2026-06-13 |
| 適用範圍 | `backend/src/routes/health/*`、`backend/src/lib/health/*`、`backend/src/plugins/lifecycle.ts` |
| 相關 ADR | `docs/decisions/002-backend-framework.md` |
| 相關 spec | `003-orm-module.md`(§13 DB 健康)、`006-redis-module.md`(§13.4 cache 健康)、`004-logger-module.md`(§6.1 排除 log)、`010-rate-limit-module.md`(§9.1 不套用) |

---

## 1. 目的與範圍

### 1.1 目的

定義 backend 的健康檢查端點與行為,讓:

- **編排平台(K8s / ECS / Fly.io / Railway)** 能正確判斷何時重啟 pod、何時加 / 移流量
- **Graceful shutdown** 期間 client 不會打到正在關閉的 instance
- **運維 / 開發者** 在故障時能用單一端點看清依賴狀態
- **避免級聯失敗**:依賴暫時不可用時不會引發大量 pod 同步重啟

### 1.2 In scope

- Liveness / Readiness / Startup 三種 probe 的端點規格
- 各 probe 檢查邏輯與 timeout
- Per-dependency 診斷端點(`/health/db`、`/health/cache`)
- Response shape(機器 vs 人讀)
- Graceful shutdown 與 readiness 的整合
- 編排平台 probe 配置建議

### 1.3 Out of scope

- **告警閾值 / on-call 設定**:由部署 / 運維 spec
- **Metrics endpoint(`/metrics`)**:由 metrics spec
- **詳細 dependency 樹狀視覺化**:dashboard 工具負責
- **跨 service 健康聚合**(BFF 看 backend、API gateway 看 backend)— 上層服務各自整合

---

## 2. 概念:三種 Probe(K8s 模型,通用於所有編排平台)

| Probe | 失敗時的編排動作 | 應檢查 | **不**應檢查 |
|---|---|---|---|
| **Liveness** | 重啟 pod | process 是否回應 | 任何外部依賴 |
| **Readiness** | 移出 service 流量(不重啟) | 必要依賴是否可達(shallow) | 完整功能測試、深查詢 |
| **Startup** | 暫緩 liveness / readiness 直到通過 | 初始化是否完成(plugin 註冊、首次 DB 連線等) | 業務功能 |

### 2.1 核心原則

1. **Liveness 不查依賴**:DB 暫時不可用時,若 liveness 連帶失敗 → 整個叢集同步重啟 → 雪崩
2. **Readiness 用 shallow 檢查**:`SELECT 1` / `PING`,不跑業務查詢
3. **Startup 處理慢啟動**:initial migration 等耗時動作完成前,讓 K8s 暫緩其他 probe
4. **Probe 永遠快速**(超時短於 K8s probe timeout 一截),否則 probe 自己會 timeout 帶來假陰性

---

## 3. 端點清單

| Path | 用途 | 對象 | 預期回應時間 |
|---|---|---|---|
| `GET /health/live` | Liveness probe | K8s liveness | < 50ms |
| `GET /health/ready` | Readiness probe | K8s readiness / LB | < 200ms |
| `GET /health/startup` | Startup probe | K8s startup | < 100ms |
| `GET /health` | 人讀的整體診斷,JSON 詳細 | 運維 / 開發者 | < 500ms |
| `GET /health/db` | DB 單獨診斷 | 運維 / 開發者 | < 200ms |
| `GET /health/cache` | Redis 單獨診斷 | 運維 / 開發者 | < 100ms |

### 3.1 路徑慣例

- 全部統一前綴 `/health/...`(已於 spec 003 §13、spec 006 §13.4 引用)
- 不採 K8s 慣例 `/livez` / `/readyz`,但編排平台配置可用任一名稱(由 probe path 指定)

---

## 4. 各端點檢查邏輯

### 4.1 `GET /health/live`

```
return 200 OK, body { "status": "alive" }
```

- **不查任何外部依賴**
- **不查 process 內部 state**(避免 false negative 引發重啟風暴)
- 只要 Fastify event loop 能處理這個 request,就代表「alive」

理由:Node.js 進程如果真的 hang 在 event loop,這個 request 也不會回應 → 自然 timeout → K8s 視為失敗。額外做 health 邏輯 = 引入新的失敗點。

### 4.2 `GET /health/ready`

```
checks (並行):
  - DB:   prisma.$queryRaw`SELECT 1`,timeout 500ms
  - Cache: redis.ping(),                timeout 200ms
  - 啟動完成旗標(§9):必須為 true

all ok       → 200 + { "status": "ready" }
any not ok   → 503 + { "status": "not_ready", "components": { db: "ok|fail", cache: "ok|fail" } }
shutting down → 503 + { "status": "draining" }  (§9)
```

- 並行檢查,**total timeout 1.5s**(K8s 預設 probe timeout 2s,留 buffer)
- 任一依賴 fail → 503;單 pod 暫時移出流量,**不**重啟
- 503 body 揭露**哪個依賴失敗**(運維友善),但不揭露錯誤訊息細節

### 4.3 `GET /health/startup`

```
checks:
  - 啟動旗標(§9):必須為 true
  - 至少一次 DB 連線成功:用 plugin-level 一次性 flag
  - 至少一次 Cache 連線成功:同上

all ok → 200 + { "status": "started" }
not ok → 503 + { "status": "starting", "elapsed_ms": N }
```

- 用於「migration 跑很久」「外部依賴遲遲不通」的場景,讓 K8s 知道「還在 boot 中」
- 通過後**不再**走實際依賴 PING(已由 readiness 覆蓋);只看 in-process 旗標
- 預期啟動時間若超過 1-2 分鐘需另設長 timeout(編排層 startup probe `failureThreshold`)

### 4.4 `GET /health`(人讀診斷)

聚合三 probe + 額外資訊,JSON 詳細,給人/監控工具看:

```json
{
  "status": "ok",                    // "ok" | "degraded" | "down"
  "version": "<git-sha-short>",      // 由 build 時注入
  "uptimeSec": 1234,
  "components": {
    "db":    { "status": "ok",  "latencyMs": 3 },
    "cache": { "status": "ok",  "latencyMs": 1 }
  },
  "startupCompleted": true,
  "shuttingDown": false
}
```

- **無認證**,但**不揭露**:OS 資訊、process pid、檔案路徑、env vars、secret
- `status = "ok"` 對應 200;`"degraded"` 對應 200(某些非必要依賴失敗,後續定義);`"down"` 對應 503

### 4.5 `GET /health/db` / `GET /health/cache`

單獨依賴的詳細回應,給運維 debug:

```json
{
  "status": "ok",
  "latencyMs": 3,
  "details": { "ping": "OK" }
}
```

或:

```json
{
  "status": "down",
  "latencyMs": 542,
  "details": { "error": "connection_timeout" }
}
```

- 不揭露 connection string、SQL 內容、Redis key

---

## 5. Response Shape 規約

### 5.1 對齊 spec 009

- Content-Type:`application/json; charset=utf-8`
- 包含 `X-Request-Id`(spec 004 §6.3)
- 失敗時 status code 為 **503**(`SERVICE_UNAVAILABLE`),body 仍為 health JSON(**不**走 RFC 7807 Problem Details — 例外於 spec 005)
- 理由:K8s probe 不解析 RFC 7807;健康狀態為主資料,error 為附屬

### 5.2 不要回 Problem Details 的例外

| Endpoint | 失敗時 |
|---|---|
| 全部 `/health/*` | 503 + 本 spec §4 定義的 health JSON shape,**非** RFC 7807 |
| 其他所有 endpoint | RFC 7807(spec 005) |

此例外在 spec 005 §6 之後追補。

---

## 6. Cascade-Failure 防範

### 6.1 三條規則

1. **Liveness 永不查依賴**(§4.1 已落實)
2. **Readiness 用最 shallow 的查詢**(`SELECT 1` / `PING`),不跑業務 SQL、不查具體 table
3. **Readiness 失敗 ≠ 重啟**:由 K8s readiness 機制處理,僅移出流量

### 6.2 與依賴的責任邊界

| 依賴 | 短暫不可用時的處置 |
|---|---|
| DB(Prisma)| readiness 失敗 → 移出流量;backend process 仍 alive,DB 恢復後 readiness 自動通過 |
| Redis | 同上 |
| 第三方(Google OIDC)| **不**列入 readiness 檢查(因為它 down 與否與我們服務是否能應對其他流量無關) |

### 6.3 「Degraded but OK」場景

未來若引入「非必要依賴」(例:metrics 推送、CDN 圖像),這些**不**列入 readiness;掛掉時 `/health` 回 `degraded` 但仍 200,讓 K8s 維持流量。本期無此類依賴。

---

## 7. Timeout 與 Cache

### 7.1 Per-check timeout

每個依賴檢查獨立 timeout,並行執行:

| 檢查 | timeout |
|---|---|
| DB SELECT 1 | 500ms |
| Cache PING | 200ms |
| 整體 readiness 上限 | 1500ms(K8s probe timeout 2s,留 buffer) |

### 7.2 結果快取(避免高頻 probe 打依賴)

| Endpoint | Cache TTL | 理由 |
|---|---|---|
| `/health/live` | 不快取(本身就無依賴) | — |
| `/health/ready` | **1 秒**,in-memory | K8s readiness 通常 5-10 秒一次,但平台 LB 可能更頻繁 |
| `/health/startup` | 不快取(讀 in-process flag,本身就快) | — |
| `/health`、`/health/db`、`/health/cache` | 不快取(人讀,即時為佳) | — |

### 7.3 Cache 實作規則

- in-memory(`Map<endpoint, { at, payload }>`),**不**用 Redis(Redis 自己是被檢查的依賴)
- TTL 過期重新檢查;同時間多個 request 共用一個 in-flight check(避免 thundering herd)
- 程式碼集中於 `src/lib/health/`

---

## 8. 不套用的橫切關注

| 模組 | 對 `/health/*` 的行為 | 規約來源 |
|---|---|---|
| Logger(spec 004) | `onRequest` / `onResponse` 自動 log **排除** | spec 004 §6.1 已要求 |
| Rate-limit(spec 010) | L1 / L2 / L3 / L4 全部**不套用** | spec 010 §9.1 已要求 |
| Auth(spec 007 / 008) | **不需要** Bearer token | 本 spec |
| CORS / Security headers | `/health/*` 一律允許 | 本 spec |
| Idempotency-Key(spec 009 §7) | **不套用**(read-only) | 本 spec |

### 8.1 安全考量(雖然無認證)

- `/health/*` **不應**對外網直接暴露;由部署層 network policy / 反向代理規則限制(僅編排平台 / 內網存取)
- 若必須對外公開(例:第三方 status page),只暴露 `/health/live`(不含依賴細節)
- 不在回應中放可用於指紋識別的資訊(精確版號可放 short SHA;OS / Node 版本 / process pid **不放**)

---

## 9. 與 Graceful Shutdown 整合

### 9.1 流程

```
收到 SIGTERM / SIGINT
  ↓
plugin: lifecycle.ts
  setShuttingDown(true)
  → /health/ready 立即開始回 503 (status: "draining")
  ↓
sleep gracePeriod(預設 10s)
  → K8s 在此期間更新 endpoints,流量逐漸切走
  ↓
app.close()
  → Fastify drain in-flight requests(timeout 30s)
  → onClose hooks(Prisma $disconnect、Redis quit)
  ↓
process.exit(0)
```

### 9.2 旗標規則

- 由 `src/plugins/lifecycle.ts` 集中管理 `isShuttingDown` / `isStartupCompleted`
- 暴露 helper:`isShuttingDown()` / `markStarted()`
- 所有 plugin 在 register 完成後呼叫 `markStarted()`;若任一 plugin register 失敗 → process 早 exit(spec 005 §11.2)

### 9.3 readiness 在 shutdown 期間的回應

```json
HTTP/1.1 503 Service Unavailable
Content-Type: application/json; charset=utf-8

{
  "status": "draining",
  "uptimeSec": 12345
}
```

- 不含 `components`(降低 noise)
- 不包 Problem Details(§5.2)

### 9.4 Liveness 在 shutdown 期間

- **仍回 200**(process 還活著,正在 drain);若回 503 會被 K8s 重啟,反而打斷 drain
- 直到 process 真的 exit,K8s 才看到 connection refused → 視為 down

---

## 10. 編排平台 Probe 建議配置

### 10.1 Kubernetes

```yaml
livenessProbe:
  httpGet: { path: /health/live, port: 3001 }
  initialDelaySeconds: 0           # 由 startupProbe 處理初始延遲
  periodSeconds: 10
  timeoutSeconds: 2
  failureThreshold: 3              # 連續 3 次失敗才重啟

readinessProbe:
  httpGet: { path: /health/ready, port: 3001 }
  initialDelaySeconds: 0
  periodSeconds: 5
  timeoutSeconds: 2
  failureThreshold: 2              # 連續 2 次失敗即移出流量
  successThreshold: 1              # 1 次成功即重新加入

startupProbe:
  httpGet: { path: /health/startup, port: 3001 }
  periodSeconds: 2
  timeoutSeconds: 1
  failureThreshold: 30             # 給 60s 啟動上限
```

- `terminationGracePeriodSeconds: 30`(配 §9.1 的 10s draining + 後續 close)

### 10.2 Railway / Fly.io / Cloud Run

- 大多只支援單一 HTTP healthcheck;指向 `/health/ready`(涵蓋啟動完成 + 依賴可達)
- 若平台支援獨立 startup,維持 §10.1 模式

### 10.3 Local docker-compose

- 不需要 probe(平台用 `restart: unless-stopped` 即可);本 spec 不額外配置

---

## 11. 與其他模組整合

### 11.1 與 ORM(spec 003)

- spec 003 §13 已要求 `/health/db`;本 spec 落實為 `prisma.$queryRaw\`SELECT 1\`` + 500ms timeout
- DB 失敗映射至 `ServiceUnavailableError`(spec 005 §7.3),但 health endpoint 自己不拋 — 直接回 503 + JSON

### 11.2 與 Cache(spec 006)

- spec 006 §13.4 要求 `/health/cache`;本 spec 落實為 `redis.ping()` + 200ms timeout
- prod 還可額外 `CONFIG GET appendonly`(spec 006 §10.3 持久化檢查);若 ACL 禁用 CONFIG → 改由部署平台檢查,本 endpoint 不做

### 11.3 與 Logger(spec 004)

- spec 004 §6.1 要求 request / response 自動 log 排除 `/health/*`
- **例外**:Plugin / DB / Redis 在 health check 中**自己**寫的 log(例:DB 連線失敗的 error log)仍照常,不在 health endpoint 內抑制

### 11.4 與 Errors(spec 005)

- 例外:health endpoint **不**走 RFC 7807(§5.2);仍套用 spec 005 §11(programmer error 處置)以防 in-process bug

### 11.5 與 Rate-limit(spec 010)

- spec 010 §9.1 已排除 `/health/*`
- 若被惡意打,網路層阻擋(spec 011 §8.1)

### 11.6 與 Lifecycle(本 spec 第一次引入)

- `src/plugins/lifecycle.ts` 集中管理 `isShuttingDown` / `isStartupCompleted` 旗標
- 註冊 SIGTERM / SIGINT handler、執行 §9.1 drain 流程
- 與 spec 005 §9 process-level handler 不衝突:spec 005 處理 `unhandledRejection` / `uncaughtException`(異常路徑);本 spec 處理正常 shutdown

---

## 12. 觀測性

### 12.1 Events(擴充 spec 004 §9.3)

| event | 觸發 | level | audit |
|---|---|---|---|
| `health_startup_completed` | `markStarted()` 被呼叫 | info | — |
| `health_shutdown_initiated` | 收到 SIGTERM / SIGINT | info | — |
| `health_shutdown_drain_started` | readiness 切 draining | info | — |
| `health_check_failed` | readiness 任一依賴失敗 | warn | — |

### 12.2 Metrics(預留)

- `health_probe_duration_seconds{probe, component, outcome}` — histogram
- `health_probe_failures_total{probe, component}` — counter

待 metrics spec 落地。

---

## 13. 測試

### 13.1 Unit

- 依賴查詢 timeout 行為(用 stub 延遲返回,驗證 timeout 觸發失敗)
- 結果快取 TTL(連續呼叫只打依賴一次)
- in-flight 共享(同時 N 個 request 並只觸發 1 次依賴查詢)

### 13.2 Integration

- `/health/live` 永遠 200(即使 DB / Redis 真的不可用)
- `/health/ready`:
  - happy path → 200 + components ok
  - 暫停 DB container → 503 + `components.db = "fail"`
  - 暫停 Redis container → 503 + `components.cache = "fail"`
- `/health/startup`:啟動前 503,plugin 註冊完成後 200
- Shutdown 路徑:呼叫 `app.close()`(或模擬 SIGTERM),驗證:
  - readiness 立即變 draining (503)
  - liveness 仍 200
  - close 完成後 process exit

### 13.3 不測試

- K8s probe 機制本身(信任編排平台)
- 真實網路故障(由 ops 演練)

---

## 14. 安全

### 14.1 暴露面

- 預設**僅內網 / 編排層存取**;對外網由 reverse proxy 阻擋
- 若必須對外暴露(極少數場景),只開 `/health/live`,且 response 維持極簡(已是 §4.1 設計)

### 14.2 資訊洩漏

- `/health/*` 都**不**揭露:
  - process pid、user、cwd、Node 版本、OS 版本
  - env vars(任何)
  - secret 任何形式
  - 完整錯誤訊息 / stack(503 body 只放 component 名稱與狀態)
- `version` 可揭露**short SHA**(7 字元),不揭露完整 build metadata

### 14.3 Probe 偽造

- network policy 限制只接受編排層 IP / loopback
- 不需要對 probe 認證(K8s 不便加),由網路層信任

---

## 15. 開放問題

- **Build metadata 注入**:`version` 來自 `BUILD_GIT_SHA` env;由 Dockerfile / CI 注入(部署 spec 處理)。若 dev 模式無此 env,fallback `"dev"`
- **多 instance shutdown 順序**:同時收到 SIGTERM 時各自 drain;若需要 leader-followed shutdown,需 coordination(本期無)
- **依賴恢復後的「冷啟動」防護**:DB 剛恢復、connection pool 還沒 warm 時,readiness 一通過就湧入流量可能再次打掛;可加 warm-up step 或漸進開放(slow start)
- **Async dependency**(例:訊息佇列、message bus)是否列入 readiness:目前無此依賴;若有,須區分「critical」與「optional」
- **Multi-tenant probe**:單服務多租戶時,probe 是否要 per-tenant?目前單一,不必
- **混沌測試**(chaos engineering):定期演練 readiness 失敗 / 依賴抖動,留作 ops spec
- **`/health/info` 端點**:給人讀但不含依賴查詢(純 metadata:版本、uptime、git sha)。目前用 `/health` 涵蓋;若 metadata 越多,可拆出

---

## 16. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-13 | 初版 |
