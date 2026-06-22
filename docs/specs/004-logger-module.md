# Spec 004:Logger 模組(Observability — Logs)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.4 |
| 日期 | 2026-06-23 |
| 適用範圍 | `backend/src/lib/logger`、Fastify request/response 與其他模組的日誌呼叫 |
| 相關 ADR | `docs/decisions/002-backend-framework.md` |
| 相關 spec | `001-environment-config.md`(`LOG_LEVEL`)、`003-orm-module.md`(`db_*`)、`006-redis-module.md`(`cache_*`)、`007-auth-flow-google-oidc.md`(`auth_*` Google)、`008-auth-flow-password.md`(`auth_*` password)、`010-rate-limit-module.md`(`rate_limit_*`)、`011-health-check.md`(`health_*`、`/health/*` 排除)、`012-cors-and-security-headers.md`(`cors_*`、preflight 排除、`x-request-id` 驗證) |

---

## 1. 目的與範圍

### 1.1 目的

讓 backend 的日誌成為**可被機器解析、可被人查、可被追溯**的結構化資料:

- 啟動 / 異常 / 關鍵事件可追溯到單一請求
- 不洩漏 secret 與 PII
- 環境間格式一致、層級可配置
- 不影響 hot path 效能(p99 < 1ms log 操作)

### 1.2 In scope

- log 函式庫選型與設定
- 結構化欄位 schema
- 環境差異(dev / stage / prod)格式與層級
- request / response 自動日誌
- secret / PII redaction
- 模組整合(Prisma、Fastify plugins)
- 測試環境的 logger 行為

### 1.3 Out of scope(後續另立 spec)

- **Metrics**(counter / histogram / gauge) — 未來 spec
- **Tracing**(OpenTelemetry span) — 未來 spec
- **告警 / APM 工具選型**(Datadog / Honeycomb / Grafana Loki) — 由部署決策
- **業務 audit log 的保存政策**(retention、不可竄改性) — 由 compliance / 業務 spec 處理(本 spec 只定義格式)

---

## 2. 函式庫選型

採用 **`pino`**(Fastify 內建)。

### 2.1 理由

- Fastify 原生整合,`fastify.log` 即 pino instance,零黏合層
- 結構化 JSON 輸出,適合 log aggregation(ELK / Loki / Datadog)
- 速度顯著快於 winston / bunyan,async 寫入不阻塞 event loop
- 支援 redact、child logger、custom serializers,功能足

### 2.2 不採用的替代方案

- `winston` — 較慢、生態雜、無 Fastify 原生整合
- `console.log` — 無結構、無等級、無 redaction,prod 絕不使用
- 自建 wrapper — 易和 Fastify 的 logger 衝突,維護成本高

---

## 3. 環境差異

| 環境 | 格式 | 預設 `LOG_LEVEL` | Transport |
|---|---|---|---|
| dev | `pino-pretty`(彩色、單行可讀) | `debug` | stdout |
| stage | JSON | `info` | stdout(由 container runtime 收集) |
| prod | JSON | `warn` | stdout(由 log aggregator 收集) |
| test | JSON | `silent`(預設關閉) | 不輸出,可透過 `LOG_LEVEL=debug` 暫時打開 |

### 3.1 規則

- **永遠寫 stdout**,不寫檔(由 container / process supervisor 負責落地與輪替)
- prod 維持 `warn` 預設,排查時可動態調至 `debug`(透過環境變數重啟)
- 不引入第二條輸出管線(避免雙倍寫入成本與不一致)

### 3.2 預設 logger 設定草案

```ts
// src/lib/logger/index.ts(草案)
import pino, { type LoggerOptions } from 'pino'

const isDev = process.env.NODE_ENV === 'development'

export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  redact: REDACT_PATHS,                   // 見 §7
  serializers: {
    req: reqSerializer,                   // 見 §6
    res: resSerializer,
    err: pino.stdSerializers.err,
  },
  ...(isDev
    ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: true } } }
    : {}),
}
```

Fastify 啟動時 `Fastify({ logger: loggerOptions })`。

---

## 4. 日誌欄位 Schema

### 4.1 必有欄位(由 pino 自動填)

| 欄位 | 來源 | 說明 |
|---|---|---|
| `time` | pino | epoch ms |
| `level` | pino | 數值(10 / 20 / 30 / 40 / 50 / 60 對應 trace–fatal) |
| `pid` | pino | process id |
| `hostname` | pino | 機器名 |
| `msg` | 呼叫端 | 人類可讀訊息 |

### 4.2 必有欄位(由 plugin / 中介層自動填)

| 欄位 | 來源 | 何時出現 |
|---|---|---|
| `requestId` | Fastify `request.id`(由 §6.3 genReqId 解析自 `x-request-id` header) | 每個 request scope 的 log |
| `module` | child logger 帶入(見 §5) | 所有非 root logger |

### 4.3 條件欄位(視情境補充)

| 欄位 | 何時 | 規則 |
|---|---|---|
| `userId` | 認證通過後 | 字串 / UUID,絕不放 email / 姓名 |
| `req.method` / `req.url` / `req.routeUrl` | request log | `req` serializer 統一處理 |
| `res.statusCode` / `latencyMs` | response log | `res` serializer 統一處理 |
| `err.stack` / `err.code` | error log | 用 `err: error` 帶入,讓 pino serializer 處理 |
| `event` | 重要事件 log | 小寫底線命名(`startup_complete`、`request_received`),便於聚合查詢 |
| `audit` | 需保留的業務事件 | `true`,搭配 `event` 一起出現 |

### 4.4 禁止欄位

- 任何 secret(JWT、OAuth secret、DB password、cookie token)
- 任何 PII 明文(email、姓名、電話、地址、信用卡、IP 完整四段——後者 prod 視合規要求 mask)
- 完整 `req.body` / `req.headers`(只在 dev 為了 debug 暫時打開)

---

## 5. Child Logger 與模組整合

### 5.1 原則

- **每個 plugin / 模組以 child logger 命名**:`fastify.log.child({ module: 'auth' })`
- child logger 的 `module` 欄位會自動加在每筆 log 上,方便篩選
- request scope 內用 `request.log`(已自動帶 `requestId`);跨 request 的背景工作用 module-level child logger

### 5.2 命名

`module` 採小寫破折號分隔,對應檔案結構或邏輯模組:

- `module: 'db'`
- `module: 'cache'`
- `module: 'plugin-cors'`
- `module: 'startup'`

**不**用業務領域名稱(例:`module: 'donation'`)——業務模組待後續 spec 定義,本 spec 只規範格式。

### 5.3 範例(草案)

```ts
// src/plugins/cache.ts
export default fp(async (fastify) => {
  const log = fastify.log.child({ module: 'cache' })
  log.info({ event: 'connecting' }, 'connecting to cache')
  // ...
})
```

---

## 6. Request / Response Lifecycle 日誌

### 6.1 自動日誌

Fastify 預設在 `onRequest` 與 `onResponse` 各印一次。本專案**保留此機制**,僅微調:

- `req` serializer 只輸出 `method`、`url`、`routeUrl`、`remoteAddress`(prod 視合規 mask),**不**輸出 headers / body
- `res` serializer 輸出 `statusCode` 與 `latencyMs`(由 `onResponse` hook 計算 `Date.now() - request.startTime`)
- 排除清單:`/health/*` 全部端點(spec 011 §3)、`/metrics`(未來)、CORS preflight `OPTIONS`(spec 012 §3.6) — 避免 healthcheck 與 preflight 噪音淹沒 log

### 6.2 排除實作

可用 Fastify v5 的 `disableRequestLogging` + 自寫 hook,或 plugin 內判斷 path 略過。預設用後者(逐 plugin 控制)。實作於 `src/plugins/logger.ts` 的 `onRequest` 早退邏輯;`req.routerPath?.startsWith('/health/')` 或 `req.method === 'OPTIONS'` 時直接 return,不寫 log。

### 6.3 Request ID

#### 6.3.1 解析與沿用

- 接受 client / BFF 傳入的 `x-request-id` header,沿用該值
- **但**:格式須通過 spec 012 §6.5.2 安全校驗(charset `[A-Za-z0-9_-]` + 長度 16–128);不符即捨棄、重新產生
- 缺失或不合法時由 Fastify 自動產生(UUID v4)
- 回傳時將 `x-request-id` 寫回 response header,讓上游可關聯
- 跨服務追蹤(trace ID)留作未來 OpenTelemetry spec

> 注意:本服務 backend 是下游消費者,**優先沿用** BFF 帶來的 id(業界 edge-generates 慣例,spec 012 §6.5.1)。不要求特定格式(如 UUID v4),BFF 可採人類可讀的 `req_YYYY-MM-DD_<suffix>` 等格式,只需通過 §6.5.2 安全校驗。

#### 6.3.2 Fastify 接線(v0.4)

`request.id` 是「per-request id 的唯一事實來源」——它**必須**同時餵到 (a) pino log binding 與 (b) response header,否則兩端 log 雖對外宣稱對得上、實際值卻會分歧(v0.4 前的 bug:onSend hook 抓到 BFF 的 id,但 pino binding 是 Fastify auto-gen `req-1`,值不一致)。

實作位置 `src/app.ts` 的 Fastify constructor,**兩個必設選項**:

```ts
Fastify({
  genReqId: (req) => genRequestId(req.headers['x-request-id']),
  requestIdLogLabel: 'requestId',
  // 不要設 requestIdHeader —— 讓 Fastify 直接信任 inbound 會 bypass §6.5.2 校驗
})
```

- `genReqId`:把 §6.3.1 的「驗證後沿用,否則 fresh UUID」邏輯放在 Fastify 建立 `request.id` 之前,確保 binding 與 echoed header 同源
- `requestIdLogLabel: 'requestId'`:把 pino 預設的 `reqId` 改為 `requestId`,對齊前端 log 慣例(`frontend/src/lib/log.ts`)與 HTTP header 名稱(`X-Request-Id`)

`genRequestId(...)` 實作於 `src/lib/http/request-id.ts`,測試覆蓋於 `request-id.test.ts`(純函式)與 `request-id-wiring.test.ts`(end-to-end Fastify 接線,驗證 log binding == response header == validated inbound)。

---

## 7. PII / Secret Redaction

### 7.1 預設 redact 路徑

```ts
const REDACT_PATHS = [
  // headers
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  // common secret-like body fields
  'req.body.password',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.accessToken',
  'req.body.clientSecret',
  // env snapshot at startup (見 §11)
  '*.JWT_SECRET',
  '*.DB_PASSWORD',
  '*.GOOGLE_CLIENT_SECRET',
  '*.password',
]
```

被 redact 的欄位輸出為 `"[Redacted]"`(pino 預設)。

### 7.2 規則

- **新增任何接受 secret 的端點 / payload 時,必須同步擴充 `REDACT_PATHS`**,並在 PR 中審查
- redaction 是最後一道防線,**不是**「可以隨便 log」的理由——能不寫 secret 就不寫
- 對於非結構化字串(例:`logger.info('token=abc123')`),redact 無效;**禁止用字串拼接含 secret 的 log**

### 7.3 IP 與 user-agent

- 預設**僅 dev / stage** 紀錄完整 IP / UA
- prod 視合規要求 mask(例:IPv4 第四段歸零),由 plugin hook 統一處理
- 細節留待部署 / 合規 spec 決定;本 spec 提供 hook 點

---

## 8. Error Logging

### 8.1 等級對應

| 情境 | level | 範例 |
|---|---|---|
| Client error 4xx(validation 失敗、預期內) | `info` | 不污染 error 流 |
| Auth 失敗 4xx(可疑流量但非系統錯) | `warn` | 量大時轉 metric |
| Server error 5xx(未預期) | `error` | 一定要含 stack |
| 啟動失敗 / 不可恢復 | `fatal` | process exit |

### 8.2 規則

- **同一個 error 只 log 一次**:由 Fastify 全域 `setErrorHandler` 統一處理,**禁止**在 route 內 `try/catch → log → re-throw`
- 一律用 `logger.error({ err })` 形式,讓 pino serializer 自動展開 stack / code,**不**用 `logger.error(err.message)`(會失去 stack)
- 5xx 必須含 `requestId`,以便對應 request lifecycle log

---

## 9. Event 與 Audit Logging

### 9.1 Event log

對需要事後查詢的關鍵動作,額外標 `event`:

```ts
log.info({ event: 'startup_complete', durationMs: 432 }, 'server ready')
log.info({ event: 'plugin_registered', name: 'cors' })
```

- `event` 採 `snake_case`,字典固定(新增 event 需更新 §9.3 字典)
- 一筆 event log 對應一次離散動作,**避免每個迴圈內都印**

### 9.2 Audit log

對需保留以供業務 / 合規追溯的事件(例:登入、權限變更),加 `audit: true`:

```ts
log.info({
  audit: true,
  event: 'auth_login_success',
  userId,
  requestId,
}, 'user logged in')
```

- audit log **不是**獨立檔案 / sink,共用主 logger(降低不一致風險)
- 由 log aggregator 過濾 `audit:true` 匯出至長期儲存
- audit 內容**禁止**包含可推回明文 secret 的資料

### 9.3 Event 字典(Infrastructure 全集)

本字典為**所有 infrastructure event 的單一事實來源**。新增 event 必須先列入本表(隨對應 spec 的 PR 同步),否則 reviewer 應 block。業務層 event(如 `donation_*`)**不**在本字典,由業務 spec 自行擴充。

#### 9.3.1 Server lifecycle(本 spec 擁有)

| event | 觸發點 | level | audit |
|---|---|---|---|
| `startup_begin` | server 啟動開始 | info | — |
| `startup_complete` | 所有 plugin register 完成、listen 成功 | info | — |
| `shutdown_begin` | 收到 SIGTERM / SIGINT | info | — |
| `shutdown_complete` | onClose hook 全部跑完 | info | — |
| `plugin_registered` | 每個 Fastify plugin register 成功 | info | — |
| `request_received` / `request_completed` | Fastify 內建 | info | — |

#### 9.3.2 Database(spec 003 擁有)

| event | 觸發點 | level | audit |
|---|---|---|---|
| `db_connected` | Prisma `$connect` 完成 | info | — |
| `db_disconnected` | Prisma `$disconnect` 完成 | info | — |
| `db_query` | Prisma query 事件(dev) | debug | — |
| `db_error` | Prisma error 事件 | error | — |

#### 9.3.3 Cache / Redis(spec 006 擁有)

| event | 觸發點 | level | audit |
|---|---|---|---|
| `cache_connected` | Redis `ready` | info | — |
| `cache_disconnected` | Redis `close` | warn | — |
| `cache_reconnecting` | Redis `reconnecting` | warn | — |
| `cache_error` | Redis `error` | error | — |
| `cache_degraded` | spec 006 §11.3 降級 | warn | — |
| `cache_recovered` | 從降級恢復 | info | — |

#### 9.3.4 Auth — Google + Identity(spec 007 擁有)

| event | 觸發點 | level | audit |
|---|---|---|---|
| `auth_authorize_init` | `/authorize-init` 成功 | info | — |
| `auth_exchange_success` | `/exchange` 登入完成、token 簽發 | info | ✅ |
| `auth_account_created` | 任一來源建立新 Account(Google 首登 / 帳密註冊) | info | ✅ |
| `auth_account_linked` | 已登入者新增 credential(Google) | info | ✅ |
| `auth_email_owned_by_other_account` | Google sign-in 時 email 被佔用,擋 409 | warn | ✅ |
| `auth_google_already_linked` | Link intent 時 Google sub 已連結到其他 Account | warn | ✅ |
| `auth_credential_exists` | Link intent 時當前 Account 已有 google credential | warn | — |
| `auth_link_session_mismatch` | Link intent 時 JWT 與 session 的 accountId 不一致 | warn | ✅ |
| `auth_refresh_success` | refresh rotation 完成 | info | — |
| `auth_refresh_replay` | 偵測到 refresh replay | warn | ✅ |
| `auth_logout` | 單 session 登出 | info | ✅ |
| `auth_logout_all` | 全裝置登出 | info | ✅ |
| `auth_oauth_session_invalid` | sid 不存在 / 過期 | warn | — |
| `auth_state_mismatch` | state 不符 | warn | — |
| `auth_id_token_invalid` | ID token 驗證失敗 | warn | — |
| `auth_email_unverified` | Google `email_verified=false` | warn | — |
| `auth_upstream_failure` | Google `/token` 5xx | error | — |

#### 9.3.5 Auth — Email + Password(spec 008 擁有)

| event | 觸發點 | level | audit |
|---|---|---|---|
| `auth_register_password` | `/register` 成功 | info | ✅ |
| `auth_login_password` | `/login` 成功 | info | ✅ |
| `auth_login_password_failed` | `/login` 任何失敗 | info | — |
| `auth_account_locked` | per-email lock 觸發 | warn | ✅ |
| `auth_password_changed` | `/password/change` 成功 | info | ✅ |
| `auth_password_set` | `/password/set` 成功 | info | ✅ |
| `auth_password_rehash` | 登入成功偵測舊參數,silent rehash | debug | — |
| `auth_rate_limited` | 任何 auth-related rate-limit 觸發 | warn | ✅ |

#### 9.3.6 Rate Limit(spec 010 擁有)

| event | 觸發點 | level | audit |
|---|---|---|---|
| `rate_limit_blocked` | 任一層拒絕 | warn | — |
| `rate_limit_redis_unavailable` | Redis 不可用 → 失敗關閉 | error | — |
| `rate_limit_bypass` | 豁免路徑觸發 bypass | debug | — |

#### 9.3.7 Health(spec 011 擁有)

| event | 觸發點 | level | audit |
|---|---|---|---|
| `health_startup_completed` | `markStarted()` 被呼叫 | info | — |
| `health_shutdown_initiated` | 收到 SIGTERM / SIGINT | info | — |
| `health_shutdown_drain_started` | readiness 切 draining | info | — |
| `health_check_failed` | readiness 任一依賴失敗 | warn | — |

#### 9.3.8 CORS / Security(spec 012 擁有)

| event | 觸發點 | level | audit |
|---|---|---|---|
| `cors_origin_rejected` | 收到 `Origin` 不在 allowlist | debug | — |
| `trusted_proxy_misconfigured` | 啟動偵測到 `RATE_LIMIT_TRUSTED_PROXIES` 在 prod 為空 | fatal | — |

### 9.4 字典治理

- 新增 event 必須:
  - 該 spec PR 內**同步更新本 §9.3** 對應子表
  - reviewer 確認**字典中無重名**(跨 spec 也不行)
- 棄用 event:
  - 在表格中保留並加 `~~~ DEPRECATED ~~~` 註記
  - 至少跨一個版本後再刪
- 字典 PR review checklist:level 是否合理、是否該 audit、是否與既有命名風格一致(`<domain>_<noun>_<verb>` 小寫底線)

---

## 10. 模組整合

### 10.1 Prisma → Logger

呼應 spec 003 §4.1:`PrismaClient` `log` 設為 `['query', 'warn', 'error']`(dev)/ `['warn', 'error']`(prod)。

整合方式:

- 使用 Prisma 的 `emit: 'event'`,將 `query` / `warn` / `error` 事件**轉發**到 child logger(`module: 'db'`)
- `query` 在 dev 為 debug 級;`error` 升級為 error 並含 SQL 摘要(已 redact 參數)

```ts
prisma.$on('query', (e) => log.debug({ event: 'db_query', duration: e.duration }, e.query))
prisma.$on('error', (e) => log.error({ event: 'db_error', target: e.target }, e.message))
```

### 10.2 Fastify plugins → Logger

所有 plugin **必須**取 child logger:

```ts
export default fp(async (fastify) => {
  const log = fastify.log.child({ module: '<plugin-name>' })
  // ...
})
```

### 10.3 第三方函式庫 → Logger

對自帶 logger 的第三方(例:`ioredis`):

- 若提供 inject hook,接管寫入到 pino child logger
- 否則接受其輸出(預設 stderr),不另作處理

---

## 11. 啟動 / 關閉日誌

### 11.1 啟動

啟動完成後**印一次設定快照**(過 redact):

```ts
log.info({
  event: 'startup_complete',
  config: {
    NODE_ENV, PORT, HOST, LOG_LEVEL,
    DB_HOST, DB_PORT, DB_USER, DB_NAME, DB_SCHEMA,   // 不含 DB_PASSWORD
    REDIS_URL: '<redacted-or-masked>',
    CORS_ORIGIN,
    // JWT / GOOGLE secrets 完全不出現
  },
}, 'server listening')
```

理由:故障排查時第一個問題就是「跑的是哪一份設定」。

### 11.2 關閉

收到 SIGTERM / SIGINT 時:

```ts
log.info({ event: 'shutdown_begin', signal }, 'shutdown initiated')
// onClose hooks run
log.info({ event: 'shutdown_complete' }, 'server stopped')
```

---

## 12. 測試環境的 Logger

呼應 backend `CLAUDE.md` §測試:

- 測試預設 `LOG_LEVEL=silent`(避免 CI / 本機跑測試時刷螢幕)
- 個別測試需驗證 log 行為時,用 `pino` 的 destination stub 或 spy(`vi.fn()`)接收輸出後斷言
- **不**改用其他 logger,測試與 prod 用同一份 logger 設定(差別只在 level / destination)

---

## 13. 效能規則

- log 呼叫應為 hot path 安全:**禁止**在迴圈內 `logger.info({ heavy: computeExpensive() })`
- 大物件 log 前以 `level >= info` guard,或改用 lazy:`if (log.isLevelEnabled('debug')) log.debug({ huge })`
- 預設 `pino.transport` 寫 stdout 即可,不引入 worker thread 除非實測有阻塞
- prod 不開 `pretty`(吃 CPU,且非結構化)

---

## 14. 開放問題

- **OpenTelemetry 整合**:trace ID / span ID 注入到 log,需另立 spec(metrics + tracing 共同)
- **Log aggregator 目的地**:Loki / Datadog / CloudWatch?待部署平台決策
- **Sampling 策略**:目前流量規模不需要;若 prod 流量上升再評估
- **動態調整 log level**:是否提供 `POST /admin/log-level`?需要先有 admin auth,留待後續
- **長期 audit retention**:由 log aggregator 處理,還是寫 DB / S3?待 compliance spec

---

## 15. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-13 | 初版 |
| 0.2 | 2026-06-13 | §9.3 event 字典聚合為單一事實來源,涵蓋 spec 003/006/007/008/010/011/012 的 ~50 個 event 並標明 level/audit/擁有者;新增 §9.4 字典治理(新增 / 棄用流程、PR review checklist);§6.1 排除路徑由 `/health` 擴為 `/health/*`(對齊 spec 011)並加 CORS preflight `OPTIONS` 排除(對齊 spec 012);§6.3 `x-request-id` 驗證 UUID v4(對齊 spec 012 §6.5) |
| 0.3 | 2026-06-17 | §6.3 對齊 spec 012 §6.5 v0.3:不再要求 inbound `x-request-id` 為 UUID v4,改為通過 §6.5.2 安全校驗(charset + 長度)。動機:讓本 backend 作為下游消費者能真正沿用 BFF 帶來的 id,使前後端 log 可串接(舊規會丟掉非 UUID 格式,correlation 失效)。新增說明 BFF 可採人類可讀格式如 `req_YYYY-MM-DD_<suffix>` |
| 0.4 | 2026-06-23 | **完成 BFF→backend log correlation 的接線**:v0.3 只放寬了 inbound 驗證,但 `request.id` 仍是 Fastify 預設自編號 `req-1`——導致 response header 顯示 BFF 的 id、pino log binding 顯示 `req-1`,**值不一致 → log join 仍不可行**。本版:(1) §6.3.2 新增 Fastify `genReqId` 接線(把 inbound 驗證搬到 `request.id` 建立之前,使 binding 與 header 同源);(2) §4.2 與 §5.1 把 log 欄位由 `reqId` 改為 `requestId`,對齊 Fastify `requestIdLogLabel` 與前端慣例。實作:`src/app.ts` 加兩行 Fastify options、`src/lib/http/request-id.ts` 新增 `genRequestId()`;新增 wiring test 證明 binding == header。下游 spec 005/009/016/022/007/025 同步把 `reqId` 改成 `requestId` |
