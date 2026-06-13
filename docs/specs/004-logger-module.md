# Spec 004:Logger 模組(Observability — Logs)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.1 |
| 日期 | 2026-06-13 |
| 適用範圍 | `backend/src/lib/logger`、Fastify request/response 與其他模組的日誌呼叫 |
| 相關 ADR | `docs/decisions/002-backend-framework.md` |
| 相關 spec | `001-environment-config.md`(`LOG_LEVEL`)、`003-orm-module.md`(Prisma log 流向) |

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
| `reqId` | Fastify `request.id` 或 `x-request-id` header | 每個 request scope 的 log |
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
- request scope 內用 `request.log`(已自動帶 `reqId`);跨 request 的背景工作用 module-level child logger

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
- 排除清單:`/health`、`/health/db`、`/metrics`(若有) — 避免 healthcheck 噪音淹沒 log

### 6.2 排除實作

可用 Fastify v5 的 `disableRequestLogging` + 自寫 hook,或 plugin 內判斷 path 略過。預設用後者(逐 plugin 控制)。

### 6.3 Request ID

- 接受 client / BFF 傳入的 `x-request-id` header,沿用該值
- 缺失時由 Fastify 自動產生(UUID v4)
- 回傳時將 `x-request-id` 寫回 response header,讓上游可關聯
- 跨服務追蹤(trace ID)留作未來 OpenTelemetry spec

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
- 5xx 必須含 `reqId`,以便對應 request lifecycle log

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
  reqId,
}, 'user logged in')
```

- audit log **不是**獨立檔案 / sink,共用主 logger(降低不一致風險)
- 由 log aggregator 過濾 `audit:true` 匯出至長期儲存
- audit 內容**禁止**包含可推回明文 secret 的資料

### 9.3 Event 字典(infrastructure 部分)

| event | 觸發點 |
|---|---|
| `startup_begin` | server 啟動開始 |
| `startup_complete` | 所有 plugin register 完成、listen 成功 |
| `shutdown_begin` | 收到 SIGTERM / SIGINT |
| `shutdown_complete` | onClose hook 全部跑完 |
| `plugin_registered` | 每個 Fastify plugin register 成功 |
| `db_connected` / `db_disconnected` | Prisma `$connect` / `$disconnect` |
| `cache_connected` / `cache_disconnected` | Redis 對應 |
| `request_received` / `request_completed` | Fastify 內建 |

業務層 event(如 `donation_*`)**不**在本 spec 字典,由業務 spec 自行擴充並 PR review。

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
