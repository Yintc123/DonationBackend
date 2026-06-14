# Spec 009:API Response 與 HTTP Status 規約

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.2 |
| 日期 | 2026-06-14 |
| 適用範圍 | 所有 backend 對外 API endpoint |
| 相關 ADR | `docs/decisions/002-backend-framework.md` |
| 相關 spec | `005-error-handling.md`(錯誤回應)、`004-logger-module.md`(`X-Request-Id` 對應 `reqId`)、`006-redis-module.md`(idempotency cache) |

---

## 1. 目的與範圍

### 1.1 目的

統一所有 endpoint 的**成功回應**:HTTP status 選用、response shape、必有 headers、分頁、快取、idempotency。確保:

- BFF / 第三方 client 可以寫**通用解析邏輯**,不必每個端點記特例
- 新 endpoint 設計時有對齊基準,降低 reviewer 認知負擔
- 與 spec 005 RFC 7807 的錯誤回應**一致風格**

### 1.2 In scope

- HTTP status code 字典(成功路徑)
- Success response body shape
- 必有 / 條件 headers
- Pagination 規約
- Caching(ETag / Cache-Control)
- Idempotency-Key 規約
- Content negotiation
- 與 Fastify response schema 的整合

### 1.3 Out of scope

- **錯誤回應** — 由 spec 005 擁有(RFC 7807 Problem Details)
- **API 版本化策略**(`/v1/...` vs header)— 後續另立或併入本 spec v0.2(目前固定 `/v1`)
- **GraphQL / gRPC** — 不在採用範圍
- **業務 endpoint 命名 / URI 結構** — 由各業務 spec 自定義,本 spec 只規範 response 層
- **公開 OpenAPI 文件產出** — 後續(Fastify swagger plugin 已預留)

---

## 2. 設計原則

### 2.1 三大原則

1. **HTTP 標準優先,不重新發明**:status code 用 RFC 7231 / 7232 的語意,不用 200 + body 內 `success: true` 假成功
2. **不包外殼**(no envelope):成功回應直接 return resource JSON,不包 `{ data: ..., meta: ... }`
3. **可由 schema 文件化**:每個 endpoint 在 Fastify route 內宣告完整 response schema,輸出由 schema 驗證(spec 005 §6 errors 亦同源於 schema)

### 2.2 為什麼不用 envelope

業界兩派:

| 方案 | 優點 | 缺點 |
|---|---|---|
| **No envelope**(本 spec 採用) | 簡潔、符合 REST、HTTP status 即可表達狀態、回應體就是 resource | List 端點需要分頁時要另想地方放 metadata |
| **Envelope** `{ data, meta, errors }` | 統一 client 解析、所有 endpoint 同 shape | 與 HTTP 重疊(status code 已能表達)、洩漏抽象、`data` 多包一層 |

選 no envelope 的關鍵:

- **錯誤路徑**已由 RFC 7807 Problem Details 用獨立 schema 統一(spec 005);成功路徑也包 envelope 等於兩種 shape 都要 client 處理
- **List 端點**用獨立 schema 處理分頁(§5),不影響其他 resource 端點
- 簡單 endpoint(`GET /v1/<resource>/:id`)直接回 resource,不必 unwrap

### 2.3 一致性比簡潔重要

凡是規範一旦確定(envelope、pagination shape、header 命名),**不可單點豁免**;新需求若不符,先改規範再實作。

---

## 3. Success HTTP Status Code 字典

### 3.1 字典

| Status | 用於 | 規則 |
|---|---|---|
| **200 OK** | `GET` 讀取成功;`POST` / `PATCH` 寫入並回傳 resource;`POST` 對 RPC-style 端點 | 多數情況預設值 |
| **201 Created** | `POST` 建立新 resource | 必須附 `Location` header 指向新 resource;body 為新 resource |
| **202 Accepted** | 非同步操作已接受、處理中 | body 含 `taskId` 或輪詢 URL;client 後續輪詢狀態 |
| **204 No Content** | `DELETE` 成功;`PUT` / `PATCH` 不需回 resource;狀態變更類動作 | body **必須**為空 |
| **304 Not Modified** | conditional `GET` 命中 ETag / `If-Modified-Since` | body 為空;不消耗頻寬 |

### 3.2 規則

- **不使用** 200 + body 內 `"success": false` / `"ok": false` 之類欄位來表達錯誤;錯誤一律走 4xx / 5xx(spec 005)
- **不混用** 204 + body 非空(部分 client / proxy 會剝掉 body)
- `200` 為「不確定用哪個」時的安全預設

### 3.3 常見場景對照

| 場景 | 方法 | Status | 備註 |
|---|---|---|---|
| 列表 | `GET /v1/<resource>` | 200 | 即使空也回 200 + `[]` |
| 單一資源 | `GET /v1/<resource>/:id` | 200 / 404 | 不存在走 404(spec 005) |
| 建立 | `POST /v1/<resource>` | 201 + `Location` | body = 新建立的 resource |
| 整體取代 | `PUT /v1/<resource>/:id` | 200 / 204 | 有回 resource 就 200;否則 204 |
| 部分更新 | `PATCH /v1/<resource>/:id` | 200 / 204 | 同上 |
| 刪除 | `DELETE /v1/<resource>/:id` | 204 | idempotent,第二次仍 204 (見 §7) |
| Action(非 CRUD) | `POST /v1/<resource>/:id/<action>` | 200 / 202 | 同步回 200,非同步回 202 |
| 認證類無 body 變更 | `POST /auth/logout` | 204 | 已於 spec 007 §7 採用 |

---

## 4. Success Response Body

### 4.1 Shape

直接回**該 resource 的 JSON**:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{
  "id": "...",
  "name": "...",
  "createdAt": "2026-06-13T01:23:45.678Z",
  ...
}
```

- 不包 `data` / `payload` / `result` 等外殼欄位
- 不放 `success` / `ok` / `code` 等元欄位(成功由 HTTP status 表達)
- 不放 `requestId`(已在 `X-Request-Id` header,§6)

### 4.2 命名

- 欄位名 `camelCase`(JS-friendly、與 Prisma 慣例一致)
- 時間用 **ISO 8601 with `Z`(UTC)** 字串,毫秒精度可選
- 列舉用大寫底線(`STATUS_NAME`),與 spec 003 §5 Prisma enum 一致

### 4.3 不該出現的欄位

- 內部 ID 不外洩(例:DB 內部 sequence id);僅暴露 UUID
- 雜湊、密碼、token、secret(由 response schema 在 Fastify 層攔截,spec 003 §7.1 已要求)
- internal flag(`isDeleted` / `isInternal` 等實作細節)

### 4.4 空欄位處理(v0.2)

- 必填欄位 → 必出現,非空
- 可選欄位 → 沒有時**回 `null`**,key **永遠存在**(原 v0.1「省略 key」改為 null;理由見下方)
- List → 沒有 item 時回 `[]`,**不**回 `null`
- 嚴禁 `null` 與 `undefined`(key 缺席)在同一欄位混用 — Fastify response schema(TypeBox `Type.Union([X, Type.Null()])`)強制 key 出現

> **為什麼改成 null(v0.2)**:client TS 型別宣告穩定(`field: string | null` 永遠合法),不用區分「key 缺席 vs null」;BFF/前端對列表卡片解構 (`const { logoUrl }`) 不會拿到 `undefined`;與目前 `src/schemas/**` 內 `Type.Union([Type.String(), Type.Null()])` 慣例一致。代價:payload size 多幾個 byte,於 cursor 列表場景可忽略。下游 spec 016 / 017 同步更新。

---

## 5. Pagination(列表分頁)

### 5.1 採用方案:Cursor-based

| 方案 | 採用 |
|---|---|
| **Cursor-based** | ✅ |
| Offset-based(`?page=N`) | ❌ — 在 large dataset 上昂貴、容易跳資料(insert 時偏移) |

### 5.2 Request

```http
GET /v1/<resource>?cursor=<opaque>&limit=50&sort=createdAt:desc
```

| 參數 | 必填 | 預設 | 上限 | 說明 |
|---|---|---|---|---|
| `cursor` | | (空,從頭) | — | server 給的 opaque token;client **不應**解析內容 |
| `limit` | | `20` | `100` | 每頁筆數 |
| `sort` | | (依 resource 預設) | — | `field:asc` / `field:desc`,多欄用 `,` 分隔;不允許任意欄位,各 endpoint 白名單 |

### 5.3 Response

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{
  "items": [
    { "id": "...", ... },
    ...
  ],
  "pageInfo": {
    "nextCursor": "<opaque-or-null>",
    "hasMore": true
  }
}
```

| 欄位 | 說明 |
|---|---|
| `items` | resource list,空時為 `[]` |
| `pageInfo.nextCursor` | 下一頁 cursor;最後一頁時為 `null` |
| `pageInfo.hasMore` | 是否還有下一頁;`false` 時 `nextCursor` 必為 `null` |

### 5.4 規則

- **不**提供 `totalCount`:在大資料集上代價高(O(N) count);如需要,另開 `/count` 端點
- cursor 採 **opaque token**,server 內部以 `base64url(JSON({lastId, lastSortValue}))` 編碼或更穩健的簽章方案;**client 不應假設格式**
- cursor 失效(對應 row 被刪)時**不**回錯,從相鄰位置續發
- 同一頁內排序穩定:`sort` field 不唯一時加 tiebreaker(通常 `id`)

---

## 6. Response Headers

### 6.1 必有

| Header | 來源 | 說明 |
|---|---|---|
| `Content-Type` | route schema | 成功一律 `application/json; charset=utf-8`;錯誤 `application/problem+json; charset=utf-8`(spec 005) |
| `X-Request-Id` | Fastify request hook | 與 log 中 `reqId` 一致(spec 004 §6.3) |

### 6.2 條件

| Header | 何時 | 規則 |
|---|---|---|
| `Location` | 201 Created | 絕對或相對 URL 指向新 resource |
| `ETag` | GET 可快取資源 | `"<weak-or-strong>"`;客戶端後續用 `If-None-Match` 取 304 |
| `Last-Modified` | GET 可快取資源 | HTTP-date 格式;與 ETag 同存可,但 ETag 更精準,優先用 ETag |
| `Cache-Control` | 所有可快取 GET | 預設 `private, max-age=0, must-revalidate`(讓 client 帶 ETag);明確不可快取用 `no-store` |
| `Retry-After` | 429 / 503 | 秒數;由 rate-limit / shutdown 流程設定 |
| `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset` | rate-limited 端點 | 由 rate-limit middleware 注入(spec 008 §7 / 未來 rate-limit spec) |

### 6.3 不該出現的 headers

- `X-Powered-By` — 洩漏 stack,由 `@fastify/helmet` 移除(`@fastify/helmet` 預設行為)
- `Server: fastify/<version>` — 同上,部署層覆寫
- 自家 secret 或內部 trace token

---

## 7. Idempotency(冪等性)

### 7.1 何時必要

| 動詞 | 預設冪等性 | 是否需 `Idempotency-Key` |
|---|---|---|
| `GET` / `HEAD` | 天生冪等 | 不需 |
| `PUT` / `DELETE` | 天生冪等(再呼叫結果一樣) | 不需 |
| `PATCH` | 不必然(視操作) | 可選 |
| `POST` 建立 | **不冪等**(重試會建多筆) | **強烈建議**,**金流類強制** |
| `POST` action | 視操作 | 對「不可逆」action 強制(例:扣款、寄信) |

### 7.2 `Idempotency-Key` Header

Client 帶 UUID(任意 client-side 產生的唯一 token);server 在 Redis 內快取首次 response,於 TTL 內收到同 key 時直接回相同 response。

### 7.3 Server 行為

```
Idempotency-Key: <key>

Lookup cache:  jkod:cache:idempotency:{endpointHash}:{key}
  hit  → 回 cached response(同 status / body / headers,加 X-Idempotency-Replay: true)
  miss → 執行業務邏輯
         成功(2xx)→ cache response(TTL 24h),回 client
         失敗(4xx / 5xx)→ **不**快取,讓 client 改 input 後可重試
```

### 7.4 規則

- `Idempotency-Key` 必為 UUID 或 ULID;否則 400 `IDEMPOTENCY_KEY_INVALID`
- 同一 key 配不同 endpoint / 不同 body → 第二次回 422 `IDEMPOTENCY_KEY_CONFLICT`(攻擊或 client bug)
- TTL **24 小時**;期間穩定回放,期外視為新請求
- key 屬 client 私有,**不**洩漏到 response

### 7.5 由 Redis cache tier 處理

呼應 spec 006 §5 Cache tier:idempotency 資料**可遺失**(client 重新發起即可),歸 cache tier。

---

## 8. Caching(GET 端點)

### 8.1 預設不快取

未明示時:

```
Cache-Control: private, max-age=0, must-revalidate
```

- 不快取在中介(`private`)
- 強制每次去 server 確認(讓 ETag 仍能取 304)

### 8.2 可快取資源:ETag-driven

```
[server]
  GET /v1/<resource>/:id
  → 200 OK
    ETag: "abc123"
    Cache-Control: private, max-age=0, must-revalidate
    body

[client 後續]
  GET /v1/<resource>/:id
  If-None-Match: "abc123"
  → 304 Not Modified  (body 空)
```

### 8.3 ETag 來源

- 以 resource 的 `updatedAt` + `id` hash(SHA-256 短碼)
- 或 row version 欄位(Prisma `@version`)

### 8.4 不可快取資源

- 含 PII 或時間敏感:`Cache-Control: no-store`
- list 端點:預設不快取(分頁 cursor 多變);特定穩定列表可加 ETag

---

## 9. Content Negotiation

### 9.1 Accept

- 接受 `application/json` 或缺省;其他 → 415 `UNSUPPORTED_MEDIA_TYPE`
- 不支援 `Accept-Encoding` 之外的 server-side 內容協商(無 XML、無 protobuf)

### 9.2 Request Content-Type

- `POST` / `PUT` / `PATCH` 需 `Content-Type: application/json`;否則 415
- 不支援 `multipart/form-data`(若日後上傳檔案,另闢端點 / spec)

### 9.3 Charset

- 一律 UTF-8;`Content-Type: application/json; charset=utf-8`

---

## 10. 與 Fastify Response Schema 整合

### 10.1 強制要求

每個 route **必須**宣告 response schema:

```ts
fastify.get('/v1/<resource>/:id', {
  schema: {
    response: {
      200: SomeResourceSchema,         // 成功
      // 4xx/5xx 由 spec 005 全域 errorHandler 處理,不在 route 列
    },
  },
}, handler)
```

理由:

- Fastify 用 response schema serialize(更快、輸出受控)
- 防止 handler 漏漏 / 多回欄位(spec 003 §7.1 already requires)
- 自動產出 OpenAPI(`@fastify/swagger`)

### 10.2 規則

- response schema **集中於** `src/schemas/responses/`,可複用
- 共用 building block(例:`PageInfoSchema`、`TimestampSchema`)放 `src/schemas/shared/`
- TypeBox 為主,與 spec 003 §7 一致

---

## 11. Empty / Null / 邊界

| 情境 | 規則 |
|---|---|
| `GET /v1/<resource>?cursor=...` 沒結果 | 200 + `{ items: [], pageInfo: { nextCursor: null, hasMore: false } }` |
| `GET /v1/<resource>/:id` 找不到 | 404 + Problem Details(spec 005) |
| `DELETE /v1/<resource>/:id` 不存在 | 204(idempotent,不要回 404) |
| 可選欄位無值 | 回 `null`(key 永遠存在,v0.2)|
| 必填欄位無值 | 不可能;表示資料異常,500 |

---

## 12. 與 Spec 005(錯誤)的邊界

| 路徑 | Content-Type | shape |
|---|---|---|
| 2xx / 3xx 成功 | `application/json` | resource JSON(本 spec) |
| 4xx / 5xx 失敗 | `application/problem+json` | RFC 7807(spec 005) |

兩條路徑**互不相容**,client 由 status code 決定走哪個 parser。

---

## 13. 範例

### 13.1 GET 單一 resource

```http
GET /v1/<resource>/abc123 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Request-Id: c4b7a5e0-8d9a-4f1f-9b3a-0e2a1b9d7f23
ETag: "v1:abc123:1718253825678"
Cache-Control: private, max-age=0, must-revalidate

{
  "id": "abc123",
  "name": "Example",
  "createdAt": "2026-06-13T01:23:45.678Z",
  "updatedAt": "2026-06-13T01:23:45.678Z"
}
```

### 13.2 GET list with pagination

```http
GET /v1/<resource>?limit=2&sort=createdAt:desc HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Request-Id: ...

{
  "items": [
    { "id": "abc123", ... },
    { "id": "def456", ... }
  ],
  "pageInfo": {
    "nextCursor": "eyJsYXN0SWQiOiJkZWY0NTYi...",
    "hasMore": true
  }
}
```

### 13.3 POST create

```http
POST /v1/<resource> HTTP/1.1
Content-Type: application/json
Idempotency-Key: 7a8d4f1e-...

{ "name": "New" }

HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
Location: /v1/<resource>/ghi789
X-Request-Id: ...

{
  "id": "ghi789",
  "name": "New",
  "createdAt": "2026-06-13T02:00:00.000Z"
}
```

### 13.4 DELETE

```http
DELETE /v1/<resource>/abc123 HTTP/1.1

HTTP/1.1 204 No Content
X-Request-Id: ...
```

### 13.5 Conditional GET → 304

```http
GET /v1/<resource>/abc123 HTTP/1.1
If-None-Match: "v1:abc123:1718253825678"

HTTP/1.1 304 Not Modified
ETag: "v1:abc123:1718253825678"
X-Request-Id: ...
```

---

## 14. 開放問題

- **API 版本化**:目前固定 `/v1`;若日後出現 breaking change,要走「新版 path」(`/v2`)還是 header(`Accept: application/vnd.jkod.v2+json`)?待出現第一個 breaking change 時決定
- **OpenAPI 文件公開**:`@fastify/swagger` 預留,但是否對外暴露(`/docs`)、是否要產文件站、是否限制只能 BFF / 內部存取?待部署 spec
- **HEAD / OPTIONS 預設**:Fastify 自動處理 HEAD;OPTIONS(CORS preflight)由 `@fastify/cors` 處理。是否需要 hand-roll?目前不需
- **GZip / Brotli 壓縮**:由 reverse proxy(部署層)處理優先;backend 不開壓縮(避免雙重壓縮 / 隱藏 BREACH 風險)
- **i18n on response**:目前 backend 一律英文 `message`(配 `code` 機器解析);若 BFF 需要本地化,改用 `code` 對照表自行翻譯
- **業務層的 `code` / event 字典**:本 spec 不擁有業務 code,由業務 spec 各自擴充並 PR review;但 PR review checklist 需新增「response shape 是否符合本 spec」
- **Idempotency-Key 的存取邊界**:目前只在 application-level;若日後跨 instance / 跨 region,key 比對需考慮 Redis instance 一致性
- **List 端點的 `totalCount` 例外**:某些後台 / 報表頁面真的需要;若需要,另開 `GET /v1/<resource>/count` 端點,不混入主 list response

---

## 15. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-13 | 初版 |
| 0.2 | 2026-06-14 | §4.4 / §11 「可選欄位無值 → 省略 key」改為「**回 `null`,key 永遠存在**」 — 對齊 Fastify TypeBox `Type.Union([X, Type.Null()])` 慣例與下游 spec 016 / 017 既有 schema,client TS 型別更穩定;下游 spec 016 v0.13、spec 017 v0.6 同步 |
