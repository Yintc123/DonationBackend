# Spec 005:錯誤處理模組

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.4 |
| 日期 | 2026-06-13 |
| 適用範圍 | `backend/src/lib/errors`、Fastify 全域 errorHandler、process-level handlers |
| 相關 ADR | `docs/decisions/002-backend-framework.md` |
| 相關 spec | `003-orm-module.md`(`P2002` 等 Prisma error 映射)、`004-logger-module.md`(error logging)、`007-auth-flow-google-oidc.md` / `008-auth-flow-password.md`(`AUTH_*` codes)、`009-api-response-and-http-status.md`(`IDEMPOTENCY_*` / `UNSUPPORTED_MEDIA_TYPE`)、`010-rate-limit-module.md`(`RATE_LIMIT_UNAVAILABLE`)、`011-health-check.md`(RFC 7807 例外) |

---

## 1. 目的與範圍

### 1.1 目的

定義 backend 服務的錯誤模型與處理流程,使:

- **client 收到的回應一致且機器可解析**(同一 schema、有可比對的 error code)
- **內部 log 含完整脈絡**(stack、cause chain、requestId)但**對外不洩漏**(SQL、stack、PII、檔案路徑)
- **single source of truth**:錯誤分類與 HTTP 對應**只在一處定義**,route handler 不重複判斷
- 區分**可預期錯誤(operational)**與**bug(programmer)**,後者讓 process 重啟而非靜默吞掉

### 1.2 In scope

- `AppError` 階層與通用 error code 字典(infrastructure 層)
- Fastify 全域 `setErrorHandler` 行為
- 對外回應格式(RFC 7807 Problem Details)
- 外部錯誤(Prisma、Redis、fetch)轉內部 `AppError` 的規則
- Process-level handler(`unhandledRejection` / `uncaughtException`)
- 與 logger、transaction、validation 的整合

### 1.3 Out of scope(後續 spec)

- 業務領域 error code(將於業務 spec 各自擴充字典)
- 告警 / on-call 政策(由部署 / 運維 spec 處理)
- 細粒度 retry 策略(idempotency、circuit breaker)— 個別整合點 spec 自處
- i18n 化的訊息文案 — 由前端 / BFF 層處理(backend 只回 code + 預設英文 message)

---

## 2. 設計哲學

### 2.1 Operational vs Programmer error(Joyent's distinction)

| 類型 | 來源 | 處置 |
|---|---|---|
| **Operational** | 預期會發生的執行期失敗(輸入錯、找不到、權限不足、外部服務暫時不可用) | 轉成 `AppError`,**正常回應**對應 HTTP status |
| **Programmer** | 程式 bug(`undefined.foo`、`TypeError`、邏輯不該到達的分支) | log + **讓 process 崩潰並由 supervisor 重啟**,不嘗試「自我修復」 |

**禁止**把 programmer error 包成 operational 後吞掉——會掩蓋 bug、累積 corrupted state。

### 2.2 三原則

1. **Single handler**:Fastify 全域 `setErrorHandler` 是唯一對外口,**route 內不 `try/catch`**(除非要轉換錯誤或加 context,且必須 re-throw)
2. **Throw,不要 return error**:用 `throw new ConflictError(...)` 而非 `return { error: '...' }`,讓控制流統一、交易自動 rollback
3. **早 fail,晚捕**:能在 schema 驗證 / `@fastify/env` 啟動時 fail 的,絕不延後到 route 內處理

### 2.3 不採用的反模式

- **巨型 `try/catch` 包整個 route handler** — 失去 stack,難對應原始失敗點
- **回傳 `{ ok: false, error }`** — 與 throw 並存導致控制流發散
- **吞掉錯誤回 `null`** — 失去資訊,debug 噩夢
- **在 route 中決定 HTTP status** — status 由 error 自身決定,單一定義來源

---

## 3. `AppError` 階層

### 3.1 基底

```ts
// src/lib/errors/AppError.ts(草案)
export type ErrorDetails = Record<string, unknown> | undefined

export class AppError extends Error {
  readonly statusCode: number       // HTTP status
  readonly code: string             // SCREAMING_SNAKE_CASE,機器可解析
  readonly details?: ErrorDetails   // 結構化補充(欄位錯誤、resource id 等)
  readonly expose: boolean          // 對外是否揭露 message;預設 true,5xx 預設 false

  constructor(opts: {
    message: string
    statusCode: number
    code: string
    details?: ErrorDetails
    cause?: unknown                 // Node 16+ Error.cause
    expose?: boolean
  }) {
    super(opts.message, { cause: opts.cause })
    this.name = new.target.name
    this.statusCode = opts.statusCode
    this.code = opts.code
    this.details = opts.details
    this.expose = opts.expose ?? opts.statusCode < 500
    Error.captureStackTrace?.(this, new.target)
  }
}
```

關鍵設計:

- **`code` 字串而非 enum**:跨服務 / log aggregator 比對方便,enum 在 wire format 上仍是字串
- **`expose` 旗標**:5xx 預設不揭露 `message` 給 client(避免內部錯誤外洩),由 errorHandler 在 mask 時參考
- **`cause` 採 Node 標準 `Error.cause`**:wrap 外部錯誤時,原 error 在 cause chain 中可追溯

### 3.2 子類別(infrastructure 通用,預設 message 與 status)

| Class | statusCode | 預設 code | 用途 |
|---|---|---|---|
| `BadRequestError` | 400 | `BAD_REQUEST` | 一般 client error;通常被更具體子類取代 |
| `ValidationError` | 400 | `VALIDATION_FAILED` | schema 驗證失敗,`details.errors` 帶欄位列表 |
| `UnauthorizedError` | 401 | `UNAUTHORIZED` | 未認證 / token 無效 |
| `ForbiddenError` | 403 | `FORBIDDEN` | 已認證但無權限 |
| `NotFoundError` | 404 | `NOT_FOUND` | resource 不存在;`details.resource` 標示型別 |
| `ConflictError` | 409 | `CONFLICT` | 唯一鍵 / 並發衝突 |
| `UnprocessableEntityError` | 422 | `UNPROCESSABLE_ENTITY` | 語法正確但業務規則拒絕(具體 code 由業務 spec 擴) |
| `TooManyRequestsError` | 429 | `RATE_LIMITED` | rate limit 觸發;`details.retryAfter` 帶秒數 |
| `InternalError` | 500 | `INTERNAL_ERROR` | 未分類 5xx;`expose=false` |
| `ServiceUnavailableError` | 503 | `SERVICE_UNAVAILABLE` | 下游服務不可用 / 啟動中 |
| `GatewayTimeoutError` | 504 | `GATEWAY_TIMEOUT` | 下游 timeout |

子類**只覆寫預設值**,不額外加邏輯:

```ts
export class NotFoundError extends AppError {
  constructor(opts: { resource: string; id?: string; cause?: unknown } & Partial<{ message: string; code: string }>) {
    super({
      message: opts.message ?? `${opts.resource} not found`,
      statusCode: 404,
      code: opts.code ?? 'NOT_FOUND',
      details: { resource: opts.resource, id: opts.id },
      cause: opts.cause,
    })
  }
}
```

### 3.3 規則

- **業務不能直接 `throw new Error(...)`**:必須走 `AppError` 或其子類
- **`Error` / `TypeError` 等原生錯誤**到達全域 handler 時,視為 programmer error(見 §11.2)
- **不替每個 endpoint 造新 class**:用 `code` 區分(例:`USER_EMAIL_TAKEN` 用 `ConflictError` + 自訂 code)

---

## 4. Error Code 字典

### 4.1 命名

- `SCREAMING_SNAKE_CASE`
- 形如 `<DOMAIN>_<NOUN>_<STATE>` 或 `<NOUN>_<VERB>`
- 通用前綴 reserved:`AUTH_*`、`VALIDATION_*`、`RATE_*`、`UPSTREAM_*`

### 4.2 Infrastructure 層字典(本 spec 擁有 — 單一事實來源)

本字典為**所有 infrastructure error code 的單一事實來源**。新增 code 必須在對應 spec 的 PR 內同步本表,否則 reviewer 應 block。

#### 4.2.1 通用(本 spec)

| code | HTTP | 語意 |
|---|---|---|
| `BAD_REQUEST` | 400 | 通用 |
| `VALIDATION_FAILED` | 400 | request body / params / query 不符 schema |
| `UNAUTHORIZED` | 401 | 缺 token / token 無效 / 過期 |
| `FORBIDDEN` | 403 | 權限不足 |
| `NOT_FOUND` | 404 | 通用 |
| `METHOD_NOT_ALLOWED` | 405 | route 存在但 method 不允許 |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Content-Type 不支援(spec 009 §9) |
| `CONFLICT` | 409 | 通用 |
| `UNPROCESSABLE_ENTITY` | 422 | 業務規則拒絕(具體 code 由業務 spec 細化) |
| `RATE_LIMITED` | 429 | rate limit |
| `INTERNAL_ERROR` | 500 | 未分類 |
| `SERVICE_UNAVAILABLE` | 503 | 啟動中 / 暫停服務 |
| `UPSTREAM_FAILURE` | 502 | 下游 5xx |
| `UPSTREAM_TIMEOUT` | 504 | 下游 timeout |
| `GATEWAY_TIMEOUT` | 504 | *(v0.4 — 同步實作)* `GatewayTimeoutError` 預設 code(§3.2);與 `UPSTREAM_TIMEOUT` 並存於 `codes.ts` |

#### 4.2.2 Auth — Google + Identity(spec 007 擁有)

| code | HTTP | 語意 |
|---|---|---|
| `AUTH_TOKEN_EXPIRED` | 401 | token 過期(精確訊號,client 可觸發 refresh) |
| `AUTH_OAUTH_SESSION_INVALID` | 401 | OAuth `sid` 不存在 / 過期 |
| `AUTH_STATE_MISMATCH` | 401 | state 不符 |
| `AUTH_OAUTH_EXCHANGE_FAILED` | 401 | Google `/token` 4xx |
| `AUTH_ID_TOKEN_INVALID` | 401 | ID token 驗證失敗(簽章 / iss / aud / exp / nonce) |
| `AUTH_EMAIL_UNVERIFIED` | 401 | Google `email_verified=false` |
| `AUTH_EMAIL_OWNED_BY_OTHER_ACCOUNT` | 409 | Google email 已被其他 Account 佔用,需手動連結 |
| `AUTH_GOOGLE_ALREADY_LINKED` | 409 | Link intent 時 Google sub 已連結到其他 Account |
| `AUTH_CREDENTIAL_EXISTS` | 409 | Link intent 時當前 Account 已有 Google credential |
| `AUTH_LINK_SESSION_MISMATCH` | 401 | Link intent 時 JWT 與 OAuth session 的 accountId 不一致 |
| `AUTH_REFRESH_REVOKED` | 401 | Refresh token 已撤銷 |
| `AUTH_REFRESH_REPLAY` | 401 | Refresh token replay 偵測 |

#### 4.2.3 Auth — Email + Password(spec 008 擁有)

| code | HTTP | 語意 |
|---|---|---|
| `AUTH_INVALID_CREDENTIALS` | 401 | 登入失敗(任何原因,enumeration resistance) |
| `AUTH_EMAIL_TAKEN` | 409 | 註冊時 email 已存在 |
| `AUTH_ACCOUNT_LOCKED` | 429 | per-email 連續失敗鎖定 |
| `AUTH_PASSWORD_NOT_SET` | 409 | 變更密碼時 Account 無 PasswordCredential |
| `AUTH_PASSWORD_ALREADY_SET` | 409 | 設定密碼時已有 PasswordCredential |

#### 4.2.4 API Response — Idempotency(spec 009 擁有)

| code | HTTP | 語意 |
|---|---|---|
| `IDEMPOTENCY_KEY_INVALID` | 400 | `Idempotency-Key` 非 UUID / ULID |
| `IDEMPOTENCY_KEY_CONFLICT` | 422 | 同 key 對應不同 endpoint / body |

#### 4.2.5 Rate Limit(spec 010 擁有)

| code | HTTP | 語意 |
|---|---|---|
| `RATE_LIMIT_UNAVAILABLE` | 503 | Redis 不可用,rate-limit 失敗關閉 |

#### 4.2.6 Persistence — Prisma(spec 003 擁有)

*(v0.4 — 同步實作:由 `src/lib/errors/prisma.ts` `mapPrismaError` emit,登錄於 `codes.ts`)*

| code | HTTP | 語意 |
|---|---|---|
| `UNIQUE_CONSTRAINT` | 409 | Prisma `P2002` unique 違反;`details.fields` 帶違反欄位(`prisma.ts:30`) |
| `FK_CONSTRAINT` | 400 | Prisma `P2003` foreign key 違反(`prisma.ts:40`) |

> `P2025`(record not found)映射為通用 `NOT_FOUND`、`P2024`(pool timeout)映射為通用 `SERVICE_UNAVAILABLE`,不另立專屬 code。

### 4.3 業務層字典

由業務 spec 各自擴充(例:`<resource>_*`、`<flow>_*`);每次新增需在該 spec 的 error code 章節登錄。本 spec 提供 lint 規則:

- **禁止跨層複用**(業務 error 不可佔用 `AUTH_*` / `UPSTREAM_*` / `IDEMPOTENCY_*` / `RATE_*` 前綴)
- 新 code **不可變更**已釋出版本的語意(僅可新增、棄用走 deprecation 流程)
- 同 4.4 治理流程

### 4.4 字典治理

- **新增 code**:擁有該業務 / 模組的 spec 在自己的 PR 中**必須同時**:
  - 在自己 spec 內 error 表加入該 code
  - 在本 §4.2 對應子表加入該 code
  - reviewer 確認無重名(跨子表也不行)
- **棄用**:標 `~~~ DEPRECATED ~~~`,保留至少一版後刪
- **HTTP status 對應一旦發布即不可變**(改變會破壞 client 解析)

---

## 5. Fastify 全域 `errorHandler`

### 5.1 結構草案

```ts
// src/plugins/error-handler.ts(草案)
import fp from 'fastify-plugin'
import { AppError, InternalError, ValidationError } from '../lib/errors'
import { mapPrismaError } from '../lib/db/errors'
import { mapFastifySchemaError } from '../lib/errors/fastify-schema'

export default fp(async (fastify) => {
  fastify.setErrorHandler((err, req, reply) => {
    const log = req.log

    // 1. Fastify schema validation error
    if ((err as any).validation) {
      const mapped = mapFastifySchemaError(err)
      log.info({ err: mapped, code: mapped.code }, 'request validation failed')
      return reply.status(mapped.statusCode).type('application/problem+json').send(toProblem(mapped, req))
    }

    // 2. AppError(operational)
    if (err instanceof AppError) {
      const level = err.statusCode >= 500 ? 'error' : 'info'
      log[level]({ err, code: err.code, statusCode: err.statusCode }, err.message)
      return reply.status(err.statusCode).type('application/problem+json').send(toProblem(err, req))
    }

    // 3. 外部已知錯誤(Prisma / Redis / fetch)— 轉成 AppError 後遞迴呼叫
    const mapped = mapKnownExternalError(err)
    if (mapped) {
      return fastify.errorHandler(mapped, req, reply)
    }

    // 4. 未知錯誤 → programmer error,視為 5xx + 內部 log,client 看 generic
    const wrapped = new InternalError({ cause: err })
    log.error({ err: wrapped, original: err }, 'unhandled error')
    return reply.status(500).type('application/problem+json').send(toProblem(wrapped, req))
  })
})
```

> **v0.4 — 同步實作**:上方為草案,實際實作在 `src/lib/errors/plugin.ts:75-83`(`resolveAppError`)略有出入:
> - schema validation 映射是**內聯**於 plugin 的 `mapFastifyValidationError`(`plugin.ts:55-68`),**無** `../lib/errors/fastify-schema` 檔
> - Prisma 映射從 `./prisma.js`(`mapPrismaError`)引入,**非** `../lib/db/errors`
> - **無** `mapKnownExternalError` 遞迴分派:`resolveAppError` 直接依序試 `AppError` → validation → `mapPrismaError` → fallback `InternalError`,不做 §5.1 草案的「map 成 AppError 後遞迴呼叫 errorHandler」
> - 額外行為:error response 一律加 `Cache-Control: no-store`(`plugin.ts:127`),`X-Request-Id` header 與 body `requestId` 同源(`request-id`)

### 5.2 規則

- **errorHandler 是唯一寫 response 的錯誤路徑**;route 內 `throw` 即可,無需自行寫 status / body
- **不在 errorHandler 內做 retry / fallback**;那是上游(plugin / route)的事
- **errorHandler 拋錯 = 不可恢復**:Fastify 會 fallback 到預設 500,但本層應確保不拋(用 try 包整段並再包成 `InternalError`)

### 5.3 404 / 405

- Fastify `setNotFoundHandler` 對應:統一拋 `NotFoundError`,讓 `errorHandler` 統一處理
- Method 不允許:Fastify 預設回 404;本專案不額外區分 405(降低複雜度),除非後續業務需要

---

## 6. 對外回應格式(RFC 7807)

採 **RFC 7807 Problem Details for HTTP APIs**(`application/problem+json`)。

### 6.0 例外:Health Probe 端點

`GET /health/live` / `/health/ready` / `/health/startup` / `/health` / `/health/db` / `/health/cache`(spec 011 §3)**不**走 RFC 7807,改回 spec 011 §4 / §5 定義的 health JSON shape。理由:

- K8s probe 機制不解析 `application/problem+json`,只看 HTTP status code
- health endpoint 的主資料是「component status」,error 為附屬

*(v0.4 — 同步實作)* 實際的全域 `errorHandler`(`src/lib/errors/plugin.ts:85-130`)**不含** health 分支——它一律輸出 `application/problem+json`。health 端點自理其 JSON shape:spec 011 的 health plugin 直接以 `reply.code().send()` 回傳成功 / 失敗 body,**不 throw 進全域 handler**,因此不會落到 RFC 7807 路徑。其他原則(status code、不洩漏細節、requestId 追蹤)仍適用。

### 6.1 格式

```json
{
  "type": "https://api.<host>/errors/<code-kebab>",
  "title": "<short human-readable>",
  "status": <httpStatus>,
  "code": "<MACHINE_CODE>",
  "detail": "<longer human-readable, optional>",
  "instance": "/<request path>",
  "requestId": "<uuid>",
  "details": { ... }            // optional;ValidationError 等帶結構化資料
}
```

### 6.2 規則

- **`Content-Type: application/problem+json`**(RFC 7807 規定)
- **`title`** 與 **`code`** 一一對應(`code` 為主鍵,`title` 為人類可讀)
- **`type`** 為 URI,本專案規約 `https://api.<host>/errors/<code-kebab>`,即使該 URI 暫無內容(預留未來文件)
- **`instance`** = request path,**不**含 query string(避免 PII)
- **`requestId`** 一律出現,對應 `x-request-id` header(spec 004 §6.3)
- 5xx 且 `expose=false` 時:`title` 為 `"Internal Server Error"`,`detail` 不出現,`code` 為通用碼;**真正 message 只進 log**
- `details` 結構化:`ValidationError` 用 `details.errors: [{ path, message, code }]`,其餘類別自行定義

### 6.3 範例

#### Validation error

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://api.example.com/errors/validation-failed",
  "title": "Validation failed",
  "status": 400,
  "code": "VALIDATION_FAILED",
  "detail": "Request body did not match schema",
  "instance": "/v1/resources",
  "requestId": "c4b7a5e0-8d9a-4f1f-9b3a-0e2a1b9d7f23",
  "details": {
    "errors": [
      { "path": "/email", "message": "must be email", "code": "format.email" }
    ]
  }
}
```

#### 內部 5xx(隱藏細節)

```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/problem+json

{
  "type": "https://api.example.com/errors/internal-error",
  "title": "Internal Server Error",
  "status": 500,
  "code": "INTERNAL_ERROR",
  "instance": "/v1/resources/abc",
  "requestId": "c4b7a5e0-8d9a-4f1f-9b3a-0e2a1b9d7f23"
}
```

---

## 7. Cause Chaining 與外部錯誤包裝

### 7.1 原則

- 外部錯誤(Prisma、Redis、fetch、第三方 SDK)**一律包成 `AppError`**,原 error 進 `cause`
- `cause` 在 log 中由 pino 自動展開,client 不可見
- 跨層多重 wrap 時保持 cause chain:`new ConflictError({ cause: prismaErr })`,prismaErr 內部還有自己的 cause 也保留

### 7.2 Prisma 映射

呼應 spec 003 §8,*(v0.4 — 同步實作)* 集中於 `src/lib/errors/prisma.ts`(非 `src/lib/db/errors.ts`;實作與下方草案一致,P-code → code 對應如 §4.2.6):

```ts
// src/lib/errors/prisma.ts
import { Prisma } from '@prisma/client'
import { ConflictError, NotFoundError, BadRequestError, ServiceUnavailableError, AppError } from '../errors'

export function mapPrismaError(err: unknown): AppError | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002': return new ConflictError({ code: 'UNIQUE_CONSTRAINT', details: { fields: err.meta?.target }, cause: err })
      case 'P2025': return new NotFoundError({ resource: 'record', cause: err })
      case 'P2003': return new BadRequestError({ message: 'Foreign key constraint failed', code: 'FK_CONSTRAINT', cause: err })
      case 'P2024': return new ServiceUnavailableError({ message: 'Database pool timeout', cause: err })
      default: return undefined        // 未知 P-code 視為 programmer error,讓上層 wrap 成 Internal
    }
  }
  return undefined
}
```

### 7.3 Redis / 第三方 HTTP

> **v0.4 — 尚未實作 / 規劃中**:下列 Redis / fetch 錯誤映射目前**未落地**——`codes.ts` 無 `CACHE_UNAVAILABLE` / `CACHE_TIMEOUT`,亦無 `src/lib/cache/errors.ts` / `mapRedisError`。現況:cache 層採**降級**而非拋錯(`src/lib/cache/with-cache.ts` 讀寫失敗只 warn log、退回 source-of-truth,不產生 5xx)。以下為目標設計,待對應整合點實作後回填字典(§4.2)。

- Redis 連線錯誤 → `ServiceUnavailableError`(`code: 'CACHE_UNAVAILABLE'`)*(規劃中)*
- fetch 5xx → `UPSTREAM_FAILURE` / 4xx → 視語意決定是否曝給 client(多數不曝)*(規劃中)*
- fetch timeout → `UPSTREAM_TIMEOUT` *(規劃中)*

每個整合點在對應 plugin / service 內提供 `mapXxxError`,errorHandler **不**為每個第三方寫 if-else。

---

## 8. Validation 錯誤

### 8.1 來源

- Fastify route schema(TypeBox / JSON Schema)驗證失敗
- `@fastify/env` 啟動驗證失敗(走 process exit,不在 request lifecycle)
- 手動 schema 驗證(罕見,優先用 route schema)

### 8.2 映射規則

Fastify 把錯誤放在 `err.validation: { instancePath, message, keyword, params }[]`。映射至 `details.errors`:

```ts
errors.map(e => ({
  path: e.instancePath,                       // 例 "/email"
  message: e.message,                         // 例 "must match format \"email\""
  code: `${e.keyword}${e.params ? '.' + Object.keys(e.params)[0] : ''}`,  // 例 "format.email"
}))
```

### 8.3 規則

- 不洩漏 schema 內部結構(例:`$ref`、`oneOf` 細節)— 預設 Ajv 訊息已足夠
- `body` / `params` / `query` 失敗一律 400,**不**回 422(422 留給「語意上有效但業務拒絕」)
- 一次回**全部**驗證失敗(Ajv `allErrors: true`),不是只回第一個

---

## 9. Process-Level Handlers

### 9.1 `unhandledRejection`

```ts
process.on('unhandledRejection', (reason, promise) => {
  rootLogger.fatal({ err: reason, promise }, 'unhandledRejection')
  // 不立即 exit:等 in-flight request 完成,但 30 秒內必須結束
  gracefulShutdown('unhandledRejection')
})
```

- 視為 **programmer error**,沒例外
- Node 15+ 預設行為已是 crash,本 handler 確保「log 完整、graceful drain」後再退

### 9.2 `uncaughtException`

```ts
process.on('uncaughtException', (err) => {
  rootLogger.fatal({ err }, 'uncaughtException')
  // 狀態可能已 corrupted,不嘗試 graceful
  process.exit(1)
})
```

- 不嘗試 graceful drain(state 可能已不可信)
- supervisor / orchestrator(Docker / k8s)負責重啟

### 9.3 SIGTERM / SIGINT

- 由 Fastify `app.close()` 觸發 `onClose` hooks(Prisma `$disconnect`、Redis quit 等)
- 不歸類為錯誤,屬正常 shutdown(spec 004 §11.2)

### 9.4 規則

- handler 只能登記**一次**;由 `src/lib/errors/process-handlers.ts` 統一註冊
- 測試環境**不**註冊 process handler(避免測試框架被影響)
- handler 內部禁拋錯(會觸發 Node abort)

---

## 10. 與其他模組整合

### 10.1 與 Logger(spec 004)

- **一個錯誤只 log 一次**:由 errorHandler 寫;route / service 內**不**重複 log 再 throw
- 4xx → `info`(client error,正常流量)
- 401/403 → `warn`(可疑流量,便於後續做 metric)
- 5xx → `error`,含 `err` 完整 stack + cause chain
- programmer error / process-level → `fatal`

### 10.2 與 Transaction(spec 003 §9)

- 互動式交易內 `throw` → Prisma 自動 `ROLLBACK`,無須額外處理
- **不要**在交易內 `try/catch` 然後 `commit`:那就是吞掉錯誤
- 交易**外**的補償操作(如發送通知)若失敗,獨立 `try/catch` 並 log,不影響主交易結果

### 10.3 與 Observability(requestId、cause chain)

- 每個錯誤回應都帶 `requestId`,可從 log 反查
- log 中 `err.cause` 由 pino `stdSerializers.err` 自動遞迴展開
- 5xx response 與 log 之間靠 `requestId` 對應,**禁止**把內部 stack 序列化到 response

---

## 11. 安全規則

### 11.1 對外回應禁出現

- stack trace
- SQL / Prisma 內部 message(P-code 可保留作 internal log key,但不寫 response)
- 檔案路徑、IP、hostname
- 任何 secret(JWT、OAuth、DB password)
- PII(email、姓名、身分證、手機)

### 11.2 Programmer error 處置

- 一律 `code: INTERNAL_ERROR`,response 不含 message
- log 必含 stack + requestId + 原始 error
- 若 process state 疑似 corrupted(死鎖、無效 invariant)→ 升級為 `fatal` + 觸發 process exit

### 11.3 Timing attack 與 enumeration

- 認證失敗統一回 `UNAUTHORIZED`,**不**區分「帳號不存在」與「密碼錯」
- `NotFoundError` 在涉及隱私的 resource 上等同 `FORBIDDEN`(避免列舉),具體在業務 spec 規範

### 11.4 Logging 自身錯誤

- `errorHandler` 內若 log 失敗(極罕見),**不**遞迴 throw — fallback 到 `console.error` 並送 default 500

---

## 12. 測試

### 12.1 單元測試 `AppError` 與子類

- 驗證 `statusCode` / `code` / `expose` 預設
- 驗證 `cause` 串連可被 `Error.cause` 走訪
- 驗證 toJSON / Problem Details 序列化形狀

### 12.2 整合測試 `errorHandler`

用 `fastify.inject()` 對受測 plugin 發 request,驗證:

- response status / `Content-Type: application/problem+json` / body shape
- 5xx 不含 stack / message 細節
- `requestId` 出現且與 request header 對應

### 12.3 外部錯誤映射測試

- 模擬 Prisma 拋 P2002,經 `mapPrismaError` 後得 `ConflictError`,response 為 409 + `UNIQUE_CONSTRAINT`
- 模擬 fetch reject,得 `UPSTREAM_FAILURE`

### 12.4 Process handler 測試

- 在 isolated child process 中觸發 `unhandledRejection`,驗證 log 與 exit code
- **不**在主測試 process 中註冊 / 觸發(會殺死 test runner)

---

## 13. 開放問題

- **Problem Details 的 `type` URI**:暫定 `https://api.<host>/errors/<code-kebab>`;是否要實際 host 這些頁面?待文件策略
- **Retry-After header**:`TooManyRequestsError` 與 `ServiceUnavailableError` 是否強制帶?目前**選擇性**,具體 plugin 視場景決定
- **i18n message**:目前一律英文;若 BFF 需要本地化,改為 BFF 用 `code` 對照表自行翻譯(backend 不負責)
- **錯誤序號 / trace context**:未來導入 OpenTelemetry 後,`traceId` / `spanId` 加進 response 與 log,本 spec 預留欄位
- **業務 error code 字典管理**:單檔集中 vs 各業務模組分散?待第二個業務 spec 出現後檢討

---

## 14. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-13 | 初版 |
| 0.2 | 2026-06-13 | §4.2 error code 字典聚合為單一事實來源,涵蓋 spec 007/008/009/010 散落的 20+ 個 code,分 5 個子表(通用 / Auth-Google / Auth-Password / Idempotency / Rate-Limit);新增 §4.4 字典治理(新增 / 棄用、HTTP status 一旦發布不可變);§6.0 新增 health probe 端點的 RFC 7807 例外(對齊 spec 011 §5.2)— K8s probe 不解析 problem+json,health 端點改回 spec 011 §4/§5 JSON shape |
| 0.3 | 2026-06-16 | §5.3 / §9 落地:`setNotFoundHandler` 統一拋 `NotFoundError`(`details.resource = req.url`),Fastify 預設 404 改走 RFC 7807;§9.1 / §9.2 process-level handler 落入 `src/lib/errors/process-handlers.ts`(`unhandledRejection` → log fatal + graceful drain;`uncaughtException` → log fatal + exit(1)),`src/server.ts` 啟動時 `registerProcessHandlers({ process, logger: app.log, shutdown })` 接上;§9.4 測試環境不註冊 — 用 injectable `ProcessLike` stub 單測;§4.2.4 dictionary 將 `IDEMPOTENCY_KEY_INVALID` / `IDEMPOTENCY_KEY_CONFLICT` 與 spec 021 `INVARIANT_VIOLATED` / spec 022 `INVALID_RECEIPT_OPTION_FOR_SUBJECT` 正式註冊到 `codes.ts` |
| 0.4 | 2026-06-16 | **同步實作**(並修正表頭版本 0.2 → 0.4 的落差):§6.0 更正——實際 `errorHandler`(`src/lib/errors/plugin.ts:85-130`)**無** health 分支,health 端點由 spec 011 plugin 自理 JSON、不 throw 進全域 handler;§4.2.1 補 `GATEWAY_TIMEOUT`(504),新增 §4.2.6 Persistence 子表登錄 `UNIQUE_CONSTRAINT`(409)/ `FK_CONSTRAINT`(400)(由 `mapPrismaError` emit);§5.1 標註草案與實作差異(validation 映射內聯、Prisma 映射由 `./prisma.js`、無 `mapKnownExternalError` 遞迴、error response 加 `no-store`);§7.2 路徑由 `src/lib/db/errors.ts` 更正為 `src/lib/errors/prisma.ts`;§7.3 Redis / fetch 錯誤映射標註**尚未實作 / 規劃中**(現況 cache 走降級不拋錯) |
