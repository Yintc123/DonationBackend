# Spec 023:API Routing Structure & Versioning(三 surface + URI versioning)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.1 |
| 日期 | 2026-06-16 |
| 適用範圍 | `backend/src/app.ts`(prefix register layout)、`backend/src/routes/**`(目錄結構重組)、`backend/src/lib/http/api-version.ts`(新,`apiVersion` 注入)、所有既有 endpoint spec(URL 對齊) |
| 相關 ADR | 待補(預計 `docs/decisions/014-api-routing-versioning.md`)|
| 相關 spec | 007 / 008(auth)、015-022(donation domain)、009(HTTP response)、010(rate-limit)、012(CORS)、005(error handling)|

---

## 1. 目的與範圍

### 1.1 目的

統一 backend 所有 HTTP endpoints 的 URL 結構,把目前散布在各 spec 的 path 慣例(`/auth/*` 無前綴、`/v1/donation/*`、`/v1/admin/*`)收斂到**三個明確的 prefix surface**:

| Surface | Prefix | 給誰用 | 版本化? |
|---|---|---|---|
| **Auth** | `/auth/*` | 一般使用者 + 後台共用(身分認證)| ❌ 不版本化 |
| **User API** | `/user/{vN}/*` | 一般使用者業務 API | ✅ URI versioning(`/user/v1/`、`/user/v2/`)|
| **CMS / 後台** | `/cms/*` | 後台管理(admin role=0)| ❌ 不版本化(內部跟著 backend 升級)|

並規範:

- 何時 v1 / v2 共用同一個 handler 函式(行為一致)
- 何時 v1 / v2 在同一個 handler 內以 `if (req.apiVersion === 'v1') ... else ...` 分歧
- 何時應該拆成兩個獨立 handler

### 1.2 In scope

- URL prefix 三分原則
- URI versioning 規則(只用 URI,不接受 header / query / Accept-Version 等其他形式)
- Fastify 落地模式(`app.register(plugin, { prefix })`)+ 版本陣列驅動的 multi-mount
- `req.apiVersion` 注入機制(onRequest hook)
- 跨版本程式碼模式:共用 handler、`if-else` 分歧、拆 handler 的判準
- scope-level preHandler:`/cms` 一次掛 `requireAdmin`、各 surface 對應的 rate-limit policy
- 目錄結構重組(`src/routes/` 改成 `public/` + `cms/`)
- 對既有 spec 的影響清單(URL 對齊路線)
- 遷移階段(雙跑 / cutover / 文件)

### 1.3 Out of scope(本期不做)

- **Content negotiation(`Accept: application/vnd.jkod.v2+json`)** — 對 BFF / CDN 較不友善,本期只走 URI
- **Header versioning(`X-API-Version: 2`)** — 同上
- **跨版本 response transformer middleware**(舊版 schema ←→ 新版 schema 自動轉)— 若需要,單獨開 spec
- **OpenAPI per-version 拆分**:本 spec 規範 routing,OpenAPI doc 整合留 spec 016 §12.1 補丁
- **Deprecation / Sunset header 機制** — 等真正要淘汰 v1 時,單獨開 spec
- **版本化的 Auth API** — `/auth/*` 故意不版本化(理由見 §2.1)

---

## 2. URL Surface 三分原則

### 2.1 為什麼 Auth 不版本化

| 議題 | 結論 |
|---|---|
| 對外承諾 | Auth 是身分基礎,所有 surface 都依賴;一旦發行就要長期穩定,**等同永遠 v1**;加 `/v1` 是噪音 |
| Breaking change 風險 | 認證流程結構大改的成本遠高於業務 API;真要改 → 新增 endpoint(`/auth/login-v2`)勝過全 surface 加版本前綴 |
| BFF / external | 認證流程已被多種 client(行動端、第三方 OAuth)固定,版本前綴反而擾動 |

→ `/auth/register`、`/auth/login`、`/auth/refresh`、`/auth/logout`、`/auth/logout-all`、`/auth/me`、`/auth/me/archive`、`/auth/google/authorize-init`、`/auth/google/exchange`、`/auth/password/change`、`/auth/password/set` **全部無版本前綴**。

### 2.2 為什麼 User API 必須版本化

| 議題 | 結論 |
|---|---|
| 對外契約 | BFF / mobile client 持續對外發版,**業務 API breaking change 是日常**(新欄位、移除欄位、改 enum value、改 response shape) |
| Cache / CDN 友善 | URI versioning 對 CDN cache key、瀏覽器 history 都自然分離 |
| Log / metric | `routerPath` 帶 `/user/v1/...` vs `/user/v2/...`,版本流量分佈直接看 access log |

→ 所有「一般使用者業務 API」(donation reads / order create / cancel / detail / 未來 cart / favorites / ...)強制走 `/user/v{N}/*`。

### 2.3 為什麼 CMS 不版本化

| 議題 | 結論 |
|---|---|
| 使用者群體 | 後台只給內部 admin 操作;升版同步走 backend 部署,**內部工具跟 backend 完全綁定** |
| 對外承諾 | 沒有 external client 對 `/cms/*` 持續使用 |
| 加版本前綴的代價 | 內部 admin UI 跟 backend 同 repo / 同部署,毫無 ROI |

→ `/cms/donation/charities`、`/cms/donation/projects`、`/cms/donation/sale-items`、`/cms/donation/categories`、`/cms/orders`、`/cms/uploads/presign` 全部無版本前綴。

### 2.4 三 surface 完整 URL 對照表(目標狀態)

```
/auth/register                                ← spec 008
/auth/login                                   ← spec 008
/auth/refresh                                 ← spec 007
/auth/logout                                  ← spec 007
/auth/logout-all                              ← spec 007
/auth/me                                      ← spec 008
/auth/me/archive                              ← spec 008
/auth/password/change                         ← spec 008
/auth/password/set                            ← spec 008
/auth/google/authorize-init                   ← spec 007
/auth/google/exchange                         ← spec 007

/user/{v1|v2}/donation/charities              ← spec 016
/user/{v1|v2}/donation/charities/:id          ← spec 017
/user/{v1|v2}/donation/donation-projects      ← spec 016
/user/{v1|v2}/donation/donation-projects/:id  ← spec 017
/user/{v1|v2}/donation/sale-items             ← spec 016
/user/{v1|v2}/donation/sale-items/:id         ← spec 017
/user/{v1|v2}/donation/categories             ← spec 016
/user/{v1|v2}/donation/orders/charity-donation       ← spec 022
/user/{v1|v2}/donation/orders/project-donation       ← spec 022
/user/{v1|v2}/donation/orders/sale-item-purchase     ← spec 022
/user/{v1|v2}/donation/orders/:id                    ← spec 022
/user/{v1|v2}/donation/orders/:id/confirm-payment    ← spec 022
/user/{v1|v2}/donation/orders/:id/cancel             ← spec 022

/cms/donation/charities                       ← spec 020
/cms/donation/charities/:id                   ← spec 020
/cms/donation/charities/:id/archive           ← spec 020
/cms/donation/charities/:id/unarchive         ← spec 020
/cms/donation/charities/:id/restore           ← spec 020
/cms/donation/donation-projects/*             ← spec 020(同樣 5 個動詞)
/cms/donation/sale-items/*                    ← spec 020
/cms/donation/categories/*                    ← spec 020
/cms/orders                                   ← spec 022 admin list
/cms/orders/:id                               ← spec 022 admin detail / patch / delete
/cms/uploads/presign                          ← spec 018(移自 /v1/donation/uploads/presign)
```

---

## 3. URI Versioning 規則

### 3.1 版本標籤

- 格式:`v{N}`,小寫 v + 正整數 N(`v1`、`v2`、`v3` ...)
- **不接受**:`V1`、`vN.M`(semver)、`1`、`2026-06-15` 等其他形式
- 版本陣列是 const literal,程式碼一處維護(§4)

### 3.2 何時升新版

升 `v2` 的判準(任一成立即可):

| 條件 | 範例 |
|---|---|
| Request body / query 必填欄位變動 | v1 不要求 `receiptOption`,v2 要求 |
| Response shape 不相容(移欄、改型別、改 enum 值)| v1 回 `amount: number`,v2 回 `amount: { value: number; currency: string }` |
| Error code 對既有路徑語意改變 | v1 對 missing identifier 回 401,v2 改回 400 |
| 認證 / 授權規則對既有路徑變動 | v1 公開取得 order detail,v2 改成要 manageToken |

**不**升新版的情境(加欄位 / 加新 endpoint 仍是 v1):

- 加新的 optional 欄位(舊 client 忽略不影響)
- 加新 endpoint(舊 client 不打不影響)
- 修 bug(原本就該那樣)
- 改錯誤訊息文案(非 code)

### 3.3 版本陣列驅動

```ts
// src/lib/http/api-version.ts(本 spec 落地新增)
export const USER_API_VERSIONS = ['v1', 'v2'] as const
export type UserApiVersion = (typeof USER_API_VERSIONS)[number]
```

- 加新版 = 在陣列尾端加一個字串
- 移除版 = 從陣列移除(對應 routes 自動不掛載)
- 任何 code 要 enumerate 版本一律 `import { USER_API_VERSIONS }`,**不可** hardcode `['v1', 'v2']`

### 3.4 版本「下架」流程

當 `v1` 流量降至可丟棄(由 log routerPath 統計 < 0.1% 持續 N 天):

1. 在 `v1` plugin 對所有 routes 加 onSend hook,塞 `Deprecation: true` + `Sunset: <date>` header
2. 公告下架時間
3. 達 sunset 日期後,從 `USER_API_VERSIONS` 移除 `v1` → 自動 404
4. 移除 v1-only branch code(`if (req.apiVersion === 'v1')` 整段刪掉)

本 spec 不規範下架的詳細時程,留未來補丁。

---

## 4. Fastify 落地模式

### 4.1 app.ts 結構(目標)

```ts
import { USER_API_VERSIONS } from './lib/http/api-version.js'

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ /* ... */ })

  // 基礎建設 plugin(原樣)
  await app.register(loggerPolicyPlugin)
  await app.register(errorHandlerPlugin)
  await app.register(helmetPlugin)
  await app.register(corsPlugin)
  await app.register(httpResponsePlugin)
  await app.register(openapiPlugin)
  await app.register(prismaPlugin)
  await app.register(redisPlugin)
  await app.register(rateLimitPlugin)
  await app.register(authPlugin)          // app.tokenSecrets / authService
  await app.register(authContextPlugin)    // best-effort req.user
  await app.register(googleAuthPlugin)
  await app.register(s3Plugin)
  await app.register(healthPlugin)

  // === Surface 1: Auth(不版本化)===
  await app.register(async (auth) => {
    await auth.register(registerAuthRoutes, { /* spec 008 */ })
    await auth.register(registerMeRoutes)
    await auth.register(registerGoogleAuthRoutes)
  }, { prefix: '/auth' })

  // === Surface 2: User API(雙版本掛載)===
  for (const version of USER_API_VERSIONS) {
    await app.register(async (userApi) => {
      // onRequest hook 把 version 塞進 req.apiVersion
      userApi.addHook('onRequest', async (req) => {
        req.apiVersion = version
      })
      await userApi.register(registerCharityPublicRoutes)
      await userApi.register(registerProjectPublicRoutes)
      await userApi.register(registerSaleItemPublicRoutes)
      await userApi.register(registerCategoryPublicRoutes)
      await userApi.register(registerOrderPublicRoutes)
    }, { prefix: `/user/${version}` })
  }

  // === Surface 3: CMS(不版本化,scope-level admin gate)===
  await app.register(async (cms) => {
    cms.addHook('preHandler', async (req) => {
      await requireAdmin(req, app.prisma, app.tokenSecrets)
    })
    await cms.register(registerCmsCharityRoutes)
    await cms.register(registerCmsProjectRoutes)
    await cms.register(registerCmsSaleItemRoutes)
    await cms.register(registerCmsCategoryRoutes)
    await cms.register(registerCmsOrderRoutes)
    await cms.register(registerCmsPresignRoute)
  }, { prefix: '/cms' })

  return app
}
```

### 4.2 Route file 寫相對路徑

```ts
// src/routes/user/donation/orders.ts
export async function registerOrderPublicRoutes(app: FastifyInstance): Promise<void> {
  app.post('/donation/orders/charity-donation', { /* ... */ })
  app.get('/donation/orders/:id', { /* ... */ })
}
```

- **不**寫 `/v1/donation/...` 或 `/user/v1/donation/...`
- prefix 由 app.ts 的 `register({ prefix })` 一次掛
- 同一個 plugin 被掛在 `/user/v1` + `/user/v2` 兩個 prefix → handler 收到 `req.url` 自動帶對應前綴

### 4.3 `req.apiVersion` 注入

```ts
// src/lib/http/api-version.ts
declare module 'fastify' {
  interface FastifyRequest {
    /** Present on requests matched under /user/v{N}; undefined on /auth/*, /cms/*. */
    apiVersion?: UserApiVersion
  }
}
```

- **onRequest hook** 在 `/user/v{N}` plugin scope 內 inject,scope 外的 `/auth/*` / `/cms/*` 收到的 req **不含** `apiVersion`(undefined)
- handler 內讀:`if (req.apiVersion === 'v2') { ... }`

### 4.4 `/cms` scope-level requireAdmin

- 一次掛 `preHandler` hook → CMS 內所有 handler **自動受保護**,個別 handler 不再 call `requireAdmin`
- 新加 CMS endpoint 自動受 hook 保護,**減少漏寫風險**
- 401 / 403 在進 handler 前就 reject;log 看到 `routerPath` 帶 `/cms/*` 加 401/403 即知 auth 層攔截

### 4.5 Scope-level rate-limit policy(建議)

| Surface | 預設 rate-limit |
|---|---|
| `/auth/*` | per-IP 為主(登入 lock-out);個別 endpoint 在 route config 細化 |
| `/user/v{N}/*` | per-IP + per-user 雙層(authenticated route);public read 路徑可 override 為高配額 |
| `/cms/*` | per-user + per-IP 雙層(admin) |

每個 prefix scope 可在 plugin 內 attach 預設 rate-limit config(透過 hook + `req.routeOptions.config.rateLimit` 預設值)。本 spec 不規定實作細節,留 spec 010 補丁。

---

## 5. 跨版本程式碼模式

### 5.1 模式 A:共用 handler(行為 100% 一致)

```ts
// /user/v1/donation/charities — GET list
// /user/v2/donation/charities — GET list(行為相同)
app.get('/donation/charities', async (req, reply) => {
  // 行為與 apiVersion 無關
  return listCharities(...)
})
```

- 不讀 `req.apiVersion`
- 同一個 handler 物件被 plugin 多次 register 各掛在不同 prefix
- **schema 重用安全**:Fastify per-route compile,同一 schema object 給兩個 URL 各自 build validator

### 5.2 模式 B:if-else 分歧(少數欄位差異,> 70% code 共用)

```ts
app.post('/donation/orders/charity-donation', async (req, reply) => {
  const body = req.body
  // 共用 lookup + validation
  const charity = await ensureCharityLive(req.server.prisma, body.charityId)

  // 版本分歧:v2 多一個 receiptEmail required
  if (req.apiVersion === 'v2') {
    if (!body.receiptEmail) {
      throw new ValidationError({ /* ... */ })
    }
  }
  // 共用 create
  return createOrder(...)
})
```

- 分歧用 `if (req.apiVersion === 'v2') { ... } else { ... }` 直接 inline
- 每個 if 分支**必須**有對應 integration test(`apiVersion=v1` 走 X、`apiVersion=v2` 走 Y)
- 分支邏輯**單一檔內不超過 50 行**;超過 → 抽 helper(`processV2ReceiptEmail()`)或拆 handler(模式 C)

### 5.3 模式 C:拆獨立 handler(< 70% code 共用 或邏輯結構性分歧)

```ts
// src/routes/user/donation/orders-v1.ts
export async function registerOrderPublicRoutesV1(app: FastifyInstance) {
  app.post('/donation/orders/charity-donation', handlerV1)
}

// src/routes/user/donation/orders-v2.ts
export async function registerOrderPublicRoutesV2(app: FastifyInstance) {
  app.post('/donation/orders/charity-donation', handlerV2)
}

// app.ts(略)選擇性註冊
for (const version of USER_API_VERSIONS) {
  await app.register(async (userApi) => {
    userApi.addHook('onRequest', async (req) => { req.apiVersion = version })
    if (version === 'v1') {
      await userApi.register(registerOrderPublicRoutesV1)
    } else {
      await userApi.register(registerOrderPublicRoutesV2)
    }
    await userApi.register(registerCharityPublicRoutes)  // 共用 handler
  }, { prefix: `/user/${version}` })
}
```

- 兩個 handler 各自獨立檔
- 共用邏輯抽 helper(`src/domain/order/*-shared.ts`)
- 對應 OpenAPI doc 也分成兩個 entry

### 5.4 模式選擇判準

| 程式碼共用比例 | 模式 |
|---|---|
| 100% 共用,行為完全一致 | **A**(共用 handler,不讀 `apiVersion`) |
| 70% ~ 99% 共用,少數欄位 / 行為差異 | **B**(if-else inline) |
| < 70% 共用,結構性分歧 | **C**(拆獨立 handler) |

「程式碼共用比例」是 handler body 內共用行數 ÷ 總行數,**不**算 schema 物件。

### 5.5 if-else 寫法規約(模式 B)

- **正向條件先寫**:`if (req.apiVersion === 'v2') { ... }` 是新行為,`else` 是舊兼容
- **每個分支留註解**寫「這是 v1 / v2 因為什麼」,並引用 spec 變更紀錄段
- **不允許**:`switch (req.apiVersion)`(只兩個值用 if-else 即可;有第三個值時改模式 C)
- **不允許**:`req.apiVersion ?? 'v1'`(沒 apiVersion 表示 caller 走錯 surface,直接讓 undefined 跑進 if 失敗)
- **不允許**:`req.url.includes('/v2/')` — 一律用 `req.apiVersion`,不解析 URL

### 5.6 範例:Order create 假設 v2 引入 receiptEmail required(說明用,非實際需求)

```ts
app.post('/donation/orders/charity-donation', {
  schema: {
    // schema 共用:body 兩個版本都接受 receiptEmail optional
    body: CharityDonationBody,  // receiptEmail: Type.Optional(...)
    response: { 201: OrderResponse },
  },
  handler: async (req, reply) => {
    const body = req.body
    if (req.apiVersion === 'v2' && !body.receiptEmail) {
      // v2 新增:receiptEmail required(spec 022 v0.9 → v0.10)
      throw new ValidationError({
        errors: [{ path: '/receiptEmail', message: 'required in v2', code: 'invalid.required' }],
      })
    }
    return createCharityDonation({ /* ... */ }, body)
  },
})
```

- schema 仍寫成 v2 寬容版本(`receiptEmail` optional),v1 / v2 共用
- v1 / v2 行為差異透過 handler if 表達
- 若 schema 本身結構必須不同(例:新欄位是 nested object),改模式 C

---

## 6. 目錄結構建議

### 6.1 重組後

```
src/routes/
  auth/                          # /auth prefix(原 src/routes/auth/)
    password.ts                  # /register, /login, /password/change, /password/set
    google.ts                    # /google/authorize-init, /google/exchange, /refresh, /logout, /logout-all
    me.ts                        # /me (GET/PATCH/DELETE), /me/archive

  user/                          # /user/{vN} prefix
    donation/
      charities.ts               # GET list / detail
      donation-projects.ts       # GET list / detail
      sale-items.ts              # GET list / detail
      categories.ts              # GET list
      orders.ts                  # POST create x3 / GET detail / confirm / cancel
    # 未來其他 user-facing endpoints(cart / favorites / profile)放這

  cms/                           # /cms prefix
    donation/
      charities.ts               # POST / PATCH + 4 lifecycle
      donation-projects.ts
      sale-items.ts
      categories.ts              # PATCH + 4 lifecycle(無 POST,字典表)
    orders.ts                    # GET list / GET detail / PATCH / DELETE
    uploads.ts                   # GET /uploads/presign
```

### 6.2 規則

- 一個 file 只屬於一個 surface(`auth/` / `user/` / `cms/`)
- file 內**只寫該 surface 的 endpoint**;不允許「同 file 對 user + cms 各寫一份」
- 共用業務邏輯放 `src/domain/{entity}/`(本已存在),route file 是 thin handler 引用 domain service
- 模式 C 拆 handler 時,命名加版本後綴:`orders-v1.ts` / `orders-v2.ts`(同層 file,不是子目錄)

### 6.3 import 路徑與 plugin 名

| 原 | 新 |
|---|---|
| `routes/auth/password.ts` `registerAuthRoutes` | `routes/auth/password.ts` `registerAuthRoutes`(不變)|
| `routes/v1/donation/charities/index.ts` `registerCharityRoutes` | `routes/user/donation/charities.ts` `registerCharityPublicRoutes` |
| `routes/v1/donation/charities/admin.ts` `registerCharityAdminRoutes` | `routes/cms/donation/charities.ts` `registerCmsCharityRoutes` |
| `routes/v1/admin/orders/index.ts` `registerAdminOrderRoutes` | `routes/cms/orders.ts` `registerCmsOrderRoutes` |
| `routes/v1/donation/uploads/presign.ts` `registerPresignUploadRoute` | `routes/cms/uploads.ts` `registerCmsPresignRoute` |

---

## 7. 對既有 spec 的影響

| Spec | URL 變動 | 內容 |
|---|---|---|
| 007 Google OIDC | ❌ 無 | `/auth/*` 維持 |
| 008 Password Auth | ❌ 無 | `/auth/*` 維持 |
| 015 Charity data model | ❌ 無 | DB-only |
| 016 Charity list API | ✅ 有 | `/v1/donation/*` → `/user/{vN}/donation/*` |
| 017 Detail APIs | ✅ 有 | 同上 |
| 018 Storage(presign)| ✅ 有 | `/v1/donation/uploads/presign` → `/cms/uploads/presign`(admin-only;搬到 CMS) |
| 019 Cache policy | ❌ 無 | cache key 內部結構不動;但 list endpoint URL 變,§4 路徑慣例文字要對齊 |
| 020 Donation write API | ✅ 有 | `/v1/donation/*`(admin write)→ `/cms/donation/*` |
| 022 Donation order API | ✅ 有 | public:`/v1/donation/orders/*` → `/user/{vN}/donation/orders/*`;admin:`/v1/admin/orders/*` → `/cms/orders/*` |

每個 spec 在落地時加變更紀錄條目,引用本 spec 023。

---

## 8. 遷移階段

### 8.1 階段 1:結構性 refactor(零 URL 改動)

- route file 改寫相對路徑(刪掉 `'/v1'` / `'/admin'` 等絕對前綴)
- app.ts 用 `register({ prefix })` 統一掛
- **URL 對 client 完全不變**(`/auth/register` 還是 `/auth/register`,`/v1/donation/orders` 還是 `/v1/donation/orders`,只是 prefix 變成 plugin-scope 而非 hardcode 在 url 字串內)
- 測試全綠 → commit

> 此階段把 prefix 拉出來,但**還沒**改 URL 結構。專案內部 code 變整潔,client 完全無感。

### 8.2 階段 2:URL 結構 cutover

- 把舊 prefix(`/v1/donation/*` admin 部分、`/v1/admin/*`)改為新 prefix(`/cms/*`)
- 把 public donation reads 從 `/v1/donation/*` 改為 `/user/v1/donation/*`
- 同時保留舊 URL 一段時間(dual-mount),log 看 BFF 用哪條
- BFF 同步改 URL → 切過去後,刪舊 URL

### 8.3 階段 3:加 v2(實際業務驅動)

- 當第一個 breaking change 出現,在 `USER_API_VERSIONS` 加 `'v2'`
- 對應 handler 走模式 B 或模式 C
- spec 022 / 016 / 017 等加 v2 章節說明差異
- v1 / v2 同時跑,BFF 漸進切換

### 8.4 階段 4:廢棄 v1(時程未定)

- 統計 routerPath 看 v1 流量
- 達 sunset 條件 → 從 `USER_API_VERSIONS` 移除 v1
- 清掉所有 `if (req.apiVersion === 'v1')` branch code 與 v1-only handler file

---

## 9. 測試規約

### 9.1 共用 handler(模式 A)

- 對 `/user/v1/...` 與 `/user/v2/...` 各 inject 一次,assert 行為一致(parity test)
- 同個 test 寫成 `it.each(['v1', 'v2'])('does X under %s', ...)` 表達

### 9.2 if-else 分歧(模式 B)

- 每個 `if (req.apiVersion === 'vN')` 分支**必須**有對應 test
- 命名:`> v1: <behaviour>` / `> v2: <behaviour>`
- 共用部分(if 之外)用 parity test

### 9.3 拆 handler(模式 C)

- 各 handler file 各自有完整 test suite
- 共用 helper 在 `src/domain/{entity}/`,獨立 unit test

### 9.4 surface 隔離

- `/auth/*` 不允許出現 `apiVersion` 相關 assertion
- `/cms/*` 同理;CMS test 一律帶 admin token
- `/user/v{N}` test 內若需要 admin token,代表 endpoint 放錯 surface,要回頭評估

### 9.5 alias / 雙跑階段(階段 2)

- 對舊 URL 與新 URL 各 inject 一次 → 行為相同(類似既有 `tests/integration/auth-v1-alias.test.ts` pattern)
- BFF 切完後刪此 test 與舊路徑

---

## 10. 對應 lib / helper

### 10.1 新增 `src/lib/http/api-version.ts`

```ts
export const USER_API_VERSIONS = ['v1'] as const  // 起步只 v1,業務驅動才加 v2
export type UserApiVersion = (typeof USER_API_VERSIONS)[number]

declare module 'fastify' {
  interface FastifyRequest {
    apiVersion?: UserApiVersion
  }
}
```

### 10.2 新增 onRequest hook

不需要獨立 plugin;每個 `/user/v{N}` register 內手寫:

```ts
userApi.addHook('onRequest', async (req) => {
  req.apiVersion = version
})
```

(`version` 是 closure 捕獲的字串,各 plugin 實例各自獨立)

### 10.3 移除 `src/lib/http/v1-alias.ts`(若存在)

dual-register helper 與本 spec 規範的 prefix 模式衝突(同個 handler 不再多 URL,改用 prefix register)。階段 1 開始時刪除。

---

## 11. CORS / Logger / Rate-limit policy

### 11.1 CORS(spec 012)

| Surface | Allowed origin |
|---|---|
| `/auth/*` | BFF 公開 origin(spec 012 已規範)|
| `/user/v{N}/*` | 同 BFF |
| `/cms/*` | **僅** admin UI origin(更嚴) |

CORS plugin 內依 prefix match 動態決定;本 spec 不規範細節,留 spec 012 補丁。

### 11.2 Logger(spec 004)

- request log 自動帶 `routerPath`,可 query 出 `/user/v1` vs `/user/v2` 流量分佈
- 建議:`req.log` 對 `/user/v{N}` 路徑自動加 `apiVersion` field(在 §10.2 hook 內順手 `req.log.setBindings({ apiVersion: version })`)

### 11.3 Rate-limit(spec 010)

| Surface | Policy |
|---|---|
| `/auth/*` | 維持 spec 010 + 007 / 008 各自規約 |
| `/user/v{N}/*` | public read 30/min/IP;authenticated write 60/min/user |
| `/cms/*` | 維持 spec 020 §11 雙層 |

policy 詳細參數留 spec 010 補丁。

---

## 12. 開放問題

| # | 問題 | 暫定方向 |
|---|---|---|
| 1 | OpenAPI doc 如何呈現多版本? | spec 016 §12.1 openapiPlugin 改為 per-prefix scan + 各自 schema document;每個版本一個 swagger 入口 |
| 2 | `v1` 與 `v2` 在同個 handler(模式 B)時的 OpenAPI 描述? | 兩個 endpoint 在 OpenAPI doc 各自 entry,description 引用本 spec §5.5 + 對應 if branch 註解 |
| 3 | CMS endpoint 是否走 OpenAPI 公開? | 內部工具不需公開 OpenAPI;CMS 入口排除在 openapi.json 之外 |
| 4 | Deprecation / Sunset header 流程 | 未來補丁 |
| 5 | apiVersion 是否該注入 log redact? | 不需要(版本是 metric,非敏感)|
| 6 | 跨版本 response transformer middleware | 等真正用到再 spec(YAGNI)|
| 7 | mobile client SDK 對版本協商 | 對外 SDK 各自寫死 URL,不做動態協商 |
| 8 | `/auth/*` 永遠不版本化? | 若認證流程真要 breaking change,新加 endpoint(`/auth/login-v2`)而非全 surface 加版本 |

---

## 13. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-16 | 初版 — 三 surface + URI versioning + 模式 A/B/C + 落地骨架 + 遷移階段。對應 future ADR 014(待補)、所有既有 endpoint spec 後續對齊條目 |
