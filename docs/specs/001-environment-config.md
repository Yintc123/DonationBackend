# Spec 001:環境設定(Environment Configuration)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.5 |
| 日期 | 2026-07-07 |
| 適用範圍 | `backend/` |
| 相關 ADR | `docs/decisions/002-backend-framework.md`、`docs/decisions/003-database-postgresql.md`、`docs/decisions/004-auth-token-strategy.md` |
| 相關 spec | 007/008(JWT、OIDC、Password)、010(Rate limit)、012(CORS、HSTS)、018(S3 storage) |

---

## 1. 目的

定義 backend 服務在 **dev / stage / prod** 三種環境的設定來源、變數內容、載入與驗證機制,確保:

- 環境之間切換不需修改程式碼,僅由環境變數驅動
- 缺漏或無效設定能在啟動時 **fail-fast**(而非執行到一半才壞)
- 敏感資料(secrets)不會進入 git
- 新成員 clone repo 後,憑 `.env.example` 與本文件即可在本機跑起來

## 2. 環境定義

| Env | 用途 | `NODE_ENV` | 設定來源 |
|---|---|---|---|
| `dev` | 本機開發 | `development` | `.env`(gitignored),參考 `.env.example` |
| `stage` | 整合測試 / 預備環境 | `staging` | 部署平台環境變數 |
| `prod` | 正式環境 | `production` | 部署平台環境變數 + secret manager |

> 作業階段可能不會實際部署 stage/prod,本 spec 仍定義以利之後擴充與面試說明。

## 3. 環境變數清單

> **必填欄位若缺漏,服務啟動時 fail-fast。**

### 3.1 Server

| Key | 必填 | dev 預設 | stage / prod | 說明 |
|---|---|---|---|---|
| `NODE_ENV` | ✅ | `development` | `staging` / `production` | 影響日誌格式、錯誤回應細節、是否啟用 pretty print |
| `PORT` | ✅ | `3001` | 由平台指定 | server listen port |
| `HOST` | | `0.0.0.0` | `0.0.0.0` | 通常無需更動 |
| `LOG_LEVEL` | | `info` | `info`(stage) / `warn`(prod) | pino log level |

### 3.2 Database (PostgreSQL via Prisma)

DB 連線採**多參數拆分**設計,理由:

- 易在部署平台 UI 個別設定,不需手動拼字串
- 各值可獨立驗證(host 格式、port 範圍、密碼長度)
- 密碼含特殊字元時,不必擔心 URL encoding 在字串中錯位
- 拆分後的「authoritative source」是各參數,`DATABASE_URL` 為**衍生值**

| Key | 必填 | dev 預設 | stage / prod | 說明 |
|---|---|---|---|---|
| `DB_HOST` | ✅ | `localhost` | 各環境獨立 host | DB 主機 |
| `DB_PORT` | ✅ | `5432` | `5432`(或平台指定) | DB port |
| `DB_USER` | ✅ | `user` | 各環境獨立帳號 | 連線帳號 |
| `DB_PASSWORD` | ✅ | `password` | 各環境獨立、secret manager 注入 | 連線密碼(secret) |
| `DB_NAME` | ✅ | `jkodonation_dev` | `jkodonation_stage` / `jkodonation_prod` | DB 名稱 |
| `DB_SCHEMA` | | `public` | `public` | PostgreSQL schema |
| `DB_SSL_MODE` | | (空) | `require`(預設)/ `verify-full` | TLS 模式 |
| `DB_CONNECTION_LIMIT` | | (空,Prisma 預設) | 由平台容量決定 | 連線池上限 |
| `DB_POOL_TIMEOUT` | | (空,Prisma 預設 10) | 由 SLA 決定 | 取得連線 timeout(秒) |
| `DATABASE_URL` | ⚠️(衍生,**不在 app schema**)| 由 `.env` dotenv-expand 或啟動腳本組合 | 由啟動腳本組合或 secret manager 直接提供 | Prisma CLI 讀;**app 在執行期改由 `composeDatabaseUrl(DB_*)` 衍生**,不從 `process.env.DATABASE_URL` 讀(v0.4) |

#### 3.2.1 組合機制

Prisma CLI(`prisma migrate`、`prisma generate` 等)只認 `DATABASE_URL`,因此環境中**必須有**組合後的 URL。兩種供應方式:

**(A) dev / 本機:由 `.env` 內 dotenv-expand 組合**

```bash
# .env
DB_HOST=localhost
DB_PORT=5432
DB_USER=user
DB_PASSWORD=password
DB_NAME=jkodonation_dev
DB_SCHEMA=public
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=${DB_SCHEMA}"
```

Prisma 內部採用 dotenv-expand,`${VAR}` 語法原生支援。

**(B) stage / prod:在部署平台 / 啟動腳本層級組合,或直接由 secret manager 注入完整 URL**

擇一即可。若平台只支援個別環境變數,需在啟動 entrypoint(`scripts/start.sh` 或 Dockerfile `CMD`)組合後 export。

#### 3.2.2 App 端使用

- TypeBox schema(`src/config/schema.ts`,由 loader 的 Ajv 於啟動時驗證)**個別驗證**拆分參數(`DB_HOST` 為字串、`DB_PORT` 為 number 等);`DATABASE_URL` **不在 schema** — 是衍生值,不屬 single source of truth(v0.4;載入機制 v0.5 — 同步實作)
- `PrismaClient` 由 `prismaPlugin` 用 `composeDatabaseUrl(DB_*)` 結果以 `datasourceUrl` 注入,不從 `process.env.DATABASE_URL` 讀(避免 dotenv 與 schema 兩個來源不同步)
- Prisma CLI(`prisma migrate` 等)仍認 `process.env.DATABASE_URL`,因此 dev `.env` / CI / 部署啟動腳本仍要 export 該變數;這條供 CLI,不供 app
- 統一組合於 `src/lib/db/compose-database-url.ts`,內部用 `URL` API 處理 percent-encode

#### 3.2.3 規則

- **三環境必須使用獨立資料庫**(`*_dev` / `*_stage` / `*_prod`),絕不共用
- `DB_PASSWORD` 屬 secret 等級;含 `@` / `:` / `/` / `?` / `#` 等字元時:
  - dev:`.env` 中需 percent-encode(例:`@` → `%40`)
  - prod:secret manager 注入時即為原始值,由 `composeDatabaseUrl` 統一編碼
- 切換環境時 Prisma migration 必須先在 stage 驗證再上 prod
- `DB_PORT` 用整數型別,schema 限制 `1024 ≤ port ≤ 65535`

### 3.3 Redis(v0.4 — 拆分參數)

對齊 §3.2 DB_* 設計,Redis 也採離散參數,理由:
- 不必處理密碼含特殊字元時的 URL percent-encode
- 部署平台 UI 個別欄位設定友善
- ioredis 直接收 `{ host, port, password }` 物件,毋須先 parse URL

| Key | 必填 | dev 預設 | stage / prod | 說明 |
|---|---|---|---|---|
| `REDIS_HOST` | ✅ | `localhost` | 各環境獨立 instance | Redis 主機 |
| `REDIS_PORT` | | `6379` | 通常 `6379` | 1–65535 |
| `REDIS_PASSWORD` | | (空,未認證) | secret manager 注入 | 空字串代表免認證(dev / LocalStack);stage / prod 必須設 |

規則:
- 三環境獨立 Redis instance,避免 cache 互相污染
- `REDIS_PASSWORD` 為 secret 等級,屬 spec 004 §7.1 redact 清單(v0.4 已落實)

### 3.4 JWT(access + refresh,落實 ADR 004)

| Key | 必填 | dev 預設 | stage / prod | 說明 |
|---|---|---|---|---|
| `JWT_ACCESS_SECRET` | ✅ | 隨機 32+ 字元 | 各環境獨立、≥ 32 字元、secret manager 注入 | access token 簽章密鑰(HS256) |
| `JWT_ACCESS_EXPIRES_IN` | | `3h` | `3h` | access token 壽命(ADR 004) |
| `JWT_REFRESH_SECRET` | ✅ | 隨機 32+ 字元(與 access 不同) | 各環境獨立、≥ 32 字元、與 access 不同密鑰 | refresh token 簽章密鑰 |
| `JWT_REFRESH_EXPIRES_IN` | | `30d` | `30d` | refresh token 壽命(ADR 004) |
| `JWT_ISSUER` | ✅ | `http://localhost:3001` | `https://api.<env-domain>` | JWT `iss` claim;對外 host 為佳 |
| `JWT_AUDIENCE` | | 同 `JWT_ISSUER` | 同 `JWT_ISSUER` | JWT `aud` claim;預設與 `iss` 相同 |

規則:
- **三環境 + access/refresh 共 6 把 secret 必須兩兩相異**,降低洩漏擴散
- 長度下限 32(由 schema `minLength` 強制)
- 不可寫入 log(spec 004 §7.1 redact)
- access 與 refresh 用**不同密鑰**:即使 access 密鑰外洩,refresh token 仍由獨立密鑰守護

### 3.5 Google OAuth 2.0 / OIDC

| Key | 必填 | dev 預設 | stage / prod | 說明 |
|---|---|---|---|---|
| `GOOGLE_CLIENT_ID` | ✅ | dev OAuth client id | 各環境獨立 client | 由 Google Cloud Console 建立 |
| `GOOGLE_CLIENT_SECRET` | ✅ | dev OAuth client secret | 各環境獨立 client | secret,不可進 git |
| `GOOGLE_CALLBACK_URL` | ✅ | `http://localhost:3000/api/auth/google/callback` | `https://app.<env-domain>/api/auth/google/callback` | 由 BFF 接收 callback(spec 007 §2.4);註冊在 Google Console |
| `OIDC_DISCOVERY_URL` | | `https://accounts.google.com/.well-known/openid-configuration` | (同) | OIDC discovery 端點;極少需改 |

規則:
- **每個環境建立獨立 Google OAuth client**,callback URL 不同
- dev 的 callback URL 用 `http://localhost:*`,Google Console 允許
- stage/prod 必須走 `https`

### 3.6 Password 與登入鎖定(spec 008)

| Key | 必填 | dev 預設 | stage / prod | 說明 |
|---|---|---|---|---|
| `PASSWORD_HASH_MEMORY_COST` | | `19456` | `19456` | Argon2id memory(KiB),OWASP 2025 下限 |
| `PASSWORD_HASH_TIME_COST` | | `2` | `2` | Argon2id iterations |
| `PASSWORD_HASH_PARALLELISM` | | `1` | `1` | Argon2id parallelism |
| `PASSWORD_MIN_LENGTH` | | `8` | `8` | 密碼最短長度(NIST 800-63B 風格) |
| `LOGIN_LOCK_THRESHOLD` | | `10` | `10` | per-email 連續失敗鎖閾值 |
| `LOGIN_LOCK_WINDOW_SEC` | | `900` | `900` | 鎖定時間(秒) |

規則:
- Argon2id 參數**寫死於 schema 預設**,變動視為 break-glass;升級時 spec 008 §3.1 silent rehash 自動遷移舊雜湊
- `PASSWORD_MIN_LENGTH` 不設上限環境變數(spec 008 §3.2 寫死 256)

### 3.7 Rate Limit(spec 010)

| Key | 必填 | dev 預設 | stage / prod | 說明 |
|---|---|---|---|---|
| `RATE_LIMIT_DISABLED` | | `false` | `false`(prod 嚴禁啟用) | v0.4 demo kill switch;`true` 時 `rateLimitPlugin` 不註冊 preHandler,完全 bypass |
| `RATE_LIMIT_GLOBAL_PER_IP_LIMIT` | | `600` | `600` | L1 限制 |
| `RATE_LIMIT_GLOBAL_PER_IP_WINDOW_SEC` | | `60` | `60` | L1 視窗 |
| `RATE_LIMIT_DEFAULT_LIMIT` | | `120` | `120` | 路徑未指定時 L2 預設 |
| `RATE_LIMIT_DEFAULT_WINDOW_SEC` | | `60` | `60` | 同上 |
| `RATE_LIMIT_FAILURE_MODE` | | `closed` | `closed` | `closed` / `open`;預設失敗關閉 |
| `RATE_LIMIT_TRUSTED_PROXIES` | ⚠️ | (空) | **必填**(BFF / LB 的 IP/CIDR,逗號分隔) | spec 010 §15.1、spec 012 §6 |

規則:
- `RATE_LIMIT_TRUSTED_PROXIES` 在 prod / stage 為**強制非空**;空字串導致啟動失敗(防 `X-Forwarded-For` 偽造攻擊)
- 接受 CIDR(`10.0.0.0/8`)或單一 IP

### 3.9 S3 Storage(spec 018,v0.4 新增)

| Key | 必填 | dev 預設 | stage / prod | 說明 |
|---|---|---|---|---|
| `S3_BUCKET` | ✅ | `jkodonation-dev` | 各環境獨立 bucket | S3 / R2 bucket 名 |
| `S3_REGION` | ✅ | `ap-northeast-1` | 對應 bucket region | AWS / R2 region |
| `S3_ENDPOINT` | | (空,走 AWS) | (空) 或 `https://<acct>.r2.cloudflarestorage.com` 之類 | LocalStack / R2 / MinIO 走自訂 endpoint |
| `S3_FORCE_PATH_STYLE` | | `false` | `false`(AWS)/ `true`(LocalStack) | path-style addressing |
| `S3_PUBLIC_URL_BASE` | | (空) | CDN base URL(可選) | 寫入 entity 的 url 欄位時拼接;空字串走 spec 018 §3 預設規則 |
| `S3_PRESIGN_TTL_SECONDS` | | `300` | `300` | presigned PUT URL 有效期(30–3600) |
| `S3_MAX_UPLOAD_BYTES` | | `5242880`(5 MiB) | `5242880` 或更高 | 上傳大小上限,進 ContentLength SigV4 簽章 |
| `AWS_ACCESS_KEY_ID` | | (空,或 LocalStack 測試金鑰) | **必須留空**(ECS task role) | SDK credential chain 自動取用;non-dev 非空即啟動失敗(v0.5 — 同步實作) |
| `AWS_SECRET_ACCESS_KEY` | | (空) | **必須留空**(ECS task role) | 同上;`post-validate` 另強制兩者「同空或同非空」(v0.5 — 同步實作) |

規則:
- `stage` / `prod` **必須留空** `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`,憑證改由 ECS task role 提供(`post-validate` v0.5 強制:non-dev 任一非空即 `throw`,避免 env 蓋掉 task role、留下長期金鑰;見 ADR 008 / spec 018 §4.1)(v0.5 — 同步實作)
- 任一環境下,兩者必須「同時為空」或「同時非空」;半組憑證會在首次 SDK 呼叫深處才失敗,故啟動即擋(v0.5 — 同步實作)
- `S3_FORCE_PATH_STYLE` 用 strict `'true'` 字串比對(spec 018 §4)

### 3.8 CORS 與 Security Headers(spec 012)

| Key | 必填 | dev 預設 | stage / prod | 說明 |
|---|---|---|---|---|
| `CORS_ORIGIN` | ✅ | `http://localhost:3000` | 對應環境 BFF URL,逗號分隔多筆 | **禁** `*`;空白拒絕 |
| `CORS_PREFLIGHT_MAX_AGE_SEC` | | `600` | `600` | preflight 快取秒數 |
| `HSTS_MAX_AGE_SEC` | | `31536000` | `31536000` | HSTS max-age(365d) |
| `HSTS_INCLUDE_SUBDOMAINS` | | `true` | `true` | HSTS includeSubDomains |
| `HSTS_PRELOAD` | | `false` | `false` | 是否加 preload(domain 上線且穩定後才開) |

規則:
- backend 只接受 BFF 來源(不直接面對瀏覽器);wildcard `*` 嚴禁
- credentials 模式啟用,因此 origin 必須具體列出

## 4. 設定載入機制

採用**自寫 loader**(`src/config/load.ts`):[`@sinclair/typebox`](https://github.com/sinclairzx81/typebox) 定義 schema,[Ajv](https://ajv.js.org/) 於啟動時驗證 + coerce + 套預設,`dotenv` / `dotenv-expand` 讀 `.env`(v0.5 — 同步實作,原規劃的 `@fastify/env` 未採用)。

### 4.1 理由

- schema(給 Ajv runtime 驗證)與 `Config` 型別(compile-time)共用單一 TypeBox 來源(`src/config/schema.ts`),drift 即 bug
- 在 **Fastify 建構前**呼叫(`src/server.ts` `main()` 內 `loadConfig()`,再 `buildApp(config)`),讓 logger(spec 004)能吃到已驗證的 `Config`;`@fastify/env` 於 plugin 註冊階段(建構後)才跑,會逼成兩段式 bootstrap(v0.5 — 同步實作)
- 缺漏 / 型別錯誤立即 fail-fast,`ConfigLoadError` 列出每個違規欄位路徑
- `dotenv-expand` 讓 `.env` 內 `DATABASE_URL="...${DB_*}..."` 正確展開供 Prisma CLI

### 4.2 替代方案(已評估,不採用)

- **`@fastify/env` plugin**:schema-driven 且型別自動推導,但只能在 plugin 註冊(Fastify 建構後)才驗證,logger 無法於建構期取用 `Config`,會逼成兩段式 bootstrap(v0.5 — 改採自寫 loader)
- `zod` + `dotenv`:驗證能力足夠,但與已選的 TypeBox schema 風格不一致

### 4.3 結構草案

> v0.4:`DATABASE_URL` 不在 `required`(衍生值);`REDIS_URL` 由 `REDIS_HOST` / `REDIS_PORT` 取代;新增 `RATE_LIMIT_DISABLED`、S3 / AWS 區塊。實際 schema 改用 TypeBox(`@sinclair/typebox`),見 `src/config/schema.ts`。

```ts
// src/config/schema.ts
export const configSchema = {
  type: 'object',
  required: [
    'NODE_ENV', 'PORT',
    'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
    'REDIS_HOST',
    'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'JWT_ISSUER',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL',
    'CORS_ORIGIN',
    'S3_BUCKET', 'S3_REGION',
  ],
  properties: {
    NODE_ENV:     { type: 'string', enum: ['development', 'staging', 'production'] },
    PORT:         { type: 'number', default: 3001 },
    HOST:         { type: 'string', default: '0.0.0.0' },
    LOG_LEVEL:    { type: 'string', enum: ['fatal','error','warn','info','debug','trace'], default: 'info' },

    // === Database(拆分參數)===
    DB_HOST:      { type: 'string', minLength: 1 },
    DB_PORT:      { type: 'number', minimum: 1024, maximum: 65535 },
    DB_USER:      { type: 'string', minLength: 1 },
    DB_PASSWORD:  { type: 'string', minLength: 1 },
    DB_NAME:      { type: 'string', minLength: 1 },
    DB_SCHEMA:    { type: 'string', default: 'public' },
    DB_SSL_MODE:  { type: 'string', enum: ['', 'require', 'verify-ca', 'verify-full'], default: '' },
    DB_CONNECTION_LIMIT: { type: 'string', default: '' },
    DB_POOL_TIMEOUT:     { type: 'string', default: '' },
    // DATABASE_URL 故意省略 — Prisma CLI 由 process.env 讀;app runtime 用 composeDatabaseUrl(DB_*) 衍生

    // === Redis (v0.4 拆分) ===
    REDIS_HOST:     { type: 'string', minLength: 1 },
    REDIS_PORT:     { type: 'number', default: 6379, minimum: 1, maximum: 65535 },
    REDIS_PASSWORD: { type: 'string', default: '' },  // 空 = 免認證 (dev / LocalStack)

    // === JWT(ADR 004 雙 token)===
    JWT_ACCESS_SECRET:    { type: 'string', minLength: 32 },
    JWT_ACCESS_EXPIRES_IN:  { type: 'string', default: '3h' },
    JWT_REFRESH_SECRET:   { type: 'string', minLength: 32 },
    JWT_REFRESH_EXPIRES_IN: { type: 'string', default: '30d' },
    JWT_ISSUER:           { type: 'string', minLength: 1 },
    JWT_AUDIENCE:         { type: 'string', default: '' },  // 空 = 沿用 issuer

    // === Google OAuth / OIDC ===
    GOOGLE_CLIENT_ID:     { type: 'string', minLength: 1 },
    GOOGLE_CLIENT_SECRET: { type: 'string', minLength: 1 },
    GOOGLE_CALLBACK_URL:  { type: 'string', minLength: 1 },  // v0.5 — 實作為 minLength,非 format:'uri'
    OIDC_DISCOVERY_URL:   { type: 'string', default: 'https://accounts.google.com/.well-known/openid-configuration' },  // v0.5 — 無 format 限制,僅預設值

    // === Password(spec 008)===
    PASSWORD_HASH_MEMORY_COST: { type: 'number', default: 19456 },
    PASSWORD_HASH_TIME_COST:   { type: 'number', default: 2 },
    PASSWORD_HASH_PARALLELISM: { type: 'number', default: 1 },
    PASSWORD_MIN_LENGTH:       { type: 'number', default: 8, minimum: 8, maximum: 256 },
    LOGIN_LOCK_THRESHOLD:      { type: 'number', default: 10, minimum: 1 },
    LOGIN_LOCK_WINDOW_SEC:     { type: 'number', default: 900, minimum: 60 },

    // === Rate Limit(spec 010)===
    RATE_LIMIT_DISABLED:                 { type: 'boolean', default: false },  // v0.4 kill switch
    RATE_LIMIT_GLOBAL_PER_IP_LIMIT:      { type: 'number', default: 600 },
    RATE_LIMIT_GLOBAL_PER_IP_WINDOW_SEC: { type: 'number', default: 60 },
    RATE_LIMIT_DEFAULT_LIMIT:            { type: 'number', default: 120 },
    RATE_LIMIT_DEFAULT_WINDOW_SEC:       { type: 'number', default: 60 },
    RATE_LIMIT_FAILURE_MODE:             { type: 'string', enum: ['closed', 'open'], default: 'closed' },
    RATE_LIMIT_TRUSTED_PROXIES:          { type: 'string', default: '' },  // prod / stage 由 §6.2 額外驗證非空

    // === CORS / Security Headers(spec 012)===
    CORS_ORIGIN:               { type: 'string', minLength: 1 },
    CORS_PREFLIGHT_MAX_AGE_SEC:{ type: 'number', default: 600 },
    HSTS_MAX_AGE_SEC:          { type: 'number', default: 31536000 },
    HSTS_INCLUDE_SUBDOMAINS:   { type: 'boolean', default: true },
    HSTS_PRELOAD:              { type: 'boolean', default: false },

    // === S3 Storage(spec 018,v0.4 新增)===
    S3_BUCKET:                 { type: 'string', minLength: 1 },
    S3_REGION:                 { type: 'string', minLength: 1 },
    S3_ENDPOINT:               { type: 'string', default: '' },
    S3_FORCE_PATH_STYLE:       { type: 'string', default: 'false' },  // strict 'true' opt-in
    S3_PUBLIC_URL_BASE:        { type: 'string', default: '' },
    S3_PRESIGN_TTL_SECONDS:    { type: 'number', default: 300, minimum: 30, maximum: 3600 },
    S3_MAX_UPLOAD_BYTES:       { type: 'number', default: 5_242_880, minimum: 1, maximum: 5_368_709_120 },  // v0.5 — 加 minimum: 1
    AWS_ACCESS_KEY_ID:         { type: 'string', default: '' },
    AWS_SECRET_ACCESS_KEY:     { type: 'string', default: '' },
  },
} as const

// src/server.ts(片段)— v0.5:於 Fastify 建構前載入,logger 才能吃到 config
const config = loadConfig()          // Ajv 驗證 + coerce + dotenv/-expand + postValidate
const app = await buildApp(config)   // config decorate 進 app.config,並餵給 createLogger
```

### 4.4 額外語意驗證(JSON Schema 表達不了的)

在 `loadConfig()` schema 驗證通過後、於 `postValidate(config)` 內執行(v0.5 — 同步實作):

```ts
// src/config/post-validate.ts — 失敗時 throw ConfigValidationError
if (config.NODE_ENV !== 'development' && config.RATE_LIMIT_TRUSTED_PROXIES === '') {
  throw new ConfigValidationError('RATE_LIMIT_TRUSTED_PROXIES must be non-empty in staging/production')
}
if (config.JWT_ACCESS_SECRET === config.JWT_REFRESH_SECRET) {
  throw new ConfigValidationError('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ')
}
// v0.5 — non-dev 跑在 ECS Fargate,憑證只能來自 task role;env 金鑰會蓋掉
// task role(SDK credential chain 偏好 env),故 non-dev 任一非空即拒絕。
const awsIdSet = config.AWS_ACCESS_KEY_ID !== ''
const awsSecretSet = config.AWS_SECRET_ACCESS_KEY !== ''
if (config.NODE_ENV !== 'development' && (awsIdSet || awsSecretSet)) {
  throw new ConfigValidationError('AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY must be empty in staging/production (use the ECS task role)')
}
// 半組憑證會在首次 SDK 呼叫深處才失敗,故不分 NODE_ENV 一律於啟動擋下。
if (awsIdSet !== awsSecretSet) {
  throw new ConfigValidationError('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must both be set or both be empty')
}
```

理由:JSON Schema 無法表達「在某環境下 X 必填」與「兩欄位必相異」這種跨欄位 invariant。

## 5. Secrets 處理

| 類型 | 載入方式 | 範例 |
|---|---|---|
| dev | `.env`(gitignored) | `.env` ← copy from `.env.example` |
| stage / prod | 部署平台環境變數;高敏感由 secret manager 注入 | Vercel/Railway env、AWS Secrets Manager、GCP Secret Manager |

### 5.1 規則

- `.env.example` **只放 key 與假值**,絕不放真實 secret
- `.env*` 除 `.env.example` 外,由 `.gitignore` 屏蔽(已設定)
- 不在 log、不在錯誤訊息、不在 metric label 中印出:
  - `JWT_SECRET`
  - `GOOGLE_CLIENT_SECRET`
  - `DATABASE_URL` 內的 password 區段
- token 一旦疑似外洩,**立即 revoke** 並更新所有環境的設定
- code review 時若發現 PR diff 含真實 secret,blocking comment

### 5.2 安全等級

| 等級 | 變數 | 處理 |
|---|---|---|
| 高敏感 | `JWT_ACCESS_SECRET`、`JWT_REFRESH_SECRET`、`GOOGLE_CLIENT_SECRET`、`DB_PASSWORD` | secret manager,定期輪替 |
| 中敏感 | `GOOGLE_CLIENT_ID`、`REDIS_URL`(含密碼時)、`DATABASE_URL`(衍生值,組合後屬高敏感) | 環境變數即可 |
| 低敏感 | `PORT`、`LOG_LEVEL`、`CORS_ORIGIN`、`GOOGLE_CALLBACK_URL`、`JWT_ISSUER`、`PASSWORD_HASH_*`、`RATE_LIMIT_*`、`HSTS_*` | 環境變數 / 設定檔皆可 |

## 6. 命名與相依

- 變數採全大寫 + `_` 分隔(POSIX 慣例)
- 同類前綴:`GOOGLE_*`、`JWT_*`、`REDIS_*`、`DATABASE_*`
- 跨環境必須對應一致:不可某環境用 `DB_URL`、另一個用 `DATABASE_URL`
- 棄用變數需在 `.env.example` 註解 `# DEPRECATED: 將於 vX.Y 移除` 至少一個版本後再刪除

## 7. 啟動驗證

| 階段 | 行為 | 失敗動作 |
|---|---|---|
| `loadConfig()`(Ajv schema 驗證) | 型別 / 必填 / range 驗證,`.env` 由 dotenv 讀入 | throw `ConfigLoadError`(列出各違規欄位路徑),server 不啟動(v0.5 — 同步實作) |
| `postValidate()` 語意驗證 | 跨欄位 invariant(`RATE_LIMIT_TRUSTED_PROXIES` 非空、access ≠ refresh、AWS keys 成對且 non-dev 留空) | throw `ConfigValidationError`;冒泡至 `server.ts` bootstrap `catch` → `console.error` + `process.exit(1)`(v0.5 — 同步實作;無專屬「缺漏 key」列印,語意錯誤屬跨欄位而非缺 key) |
| Smoke | `GET /health` 回 200 | 部署 pipeline 視為失敗 |

錯誤訊息需指明:
- 缺漏的 key 名稱
- 該 key 期望的型別 / 格式
- 應到何處設定(`.env` for dev、平台 env 設定為 stage/prod)

## 8. `.env.example` 與本 spec 的對應

詳細格式規範見 spec 002 v0.3。

**狀態:已對齊**(2026-06-13)。當前 `.env.example` 已涵蓋本 spec v0.3 的所有區塊:

- ✅ Server(NODE_ENV / PORT / HOST / LOG_LEVEL)
- ✅ Database 多參數拆分(DB_HOST / PORT / USER / PASSWORD / NAME / SCHEMA / SSL_MODE / CONNECTION_LIMIT / POOL_TIMEOUT)+ dotenv-expand 衍生 `DATABASE_URL`
- ✅ JWT access + refresh(JWT_ACCESS_SECRET / JWT_ACCESS_EXPIRES_IN / JWT_REFRESH_SECRET / JWT_REFRESH_EXPIRES_IN / JWT_ISSUER / JWT_AUDIENCE)
- ✅ Google OAuth / OIDC(GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALLBACK_URL / OIDC_DISCOVERY_URL)
- ✅ Password(PASSWORD_HASH_* × 3 / PASSWORD_MIN_LENGTH / LOGIN_LOCK_*)
- ✅ Redis(REDIS_HOST / REDIS_PORT / REDIS_PASSWORD,v0.4 拆分)
- ✅ Rate Limit(RATE_LIMIT_DISABLED + 6 條配置)
- ✅ CORS / HSTS(CORS_ORIGIN / CORS_PREFLIGHT_MAX_AGE_SEC / HSTS_* × 3)
- ✅ S3 / AWS(S3_BUCKET / S3_REGION / S3_ENDPOINT / S3_FORCE_PATH_STYLE / S3_PUBLIC_URL_BASE / S3_PRESIGN_TTL_SECONDS / S3_MAX_UPLOAD_BYTES / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY,v0.4 新增)

本 spec 與 `.env.example` 為**雙向綁定**:任一處新增 / 刪除 key,必須同 PR 修正另一處,並由 reviewer 把關。

## 9. 開放問題

- stage/prod 實際部署平台尚未決定(Vercel / Railway / Fly.io / 自架),會影響 secret 載入細節與 `GOOGLE_CALLBACK_URL` 的網域命名
- 是否引入 feature flag 機制(目前無此需求,留作未來擴充)
- 是否需要 per-tenant 設定(目前單租戶,暫不考慮)

## 10. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-13 | 初版 |
| 0.2 | 2026-06-13 | §3.2 Database 改為多參數拆分(`DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` / `DB_SCHEMA` / `DB_SSL_MODE` / `DB_CONNECTION_LIMIT` / `DB_POOL_TIMEOUT`),`DATABASE_URL` 改為 dotenv-expand 衍生;§4.3 schema 範例同步;§8 同步缺漏清單 |
| 0.3 | 2026-06-13 | §3.4 JWT 拆 access + refresh(ADR 004);§3.5 加 `OIDC_DISCOVERY_URL`;新增 §3.6 Password(Argon2 / login lock);新增 §3.7 Rate Limit;§3.8 CORS 擴含 HSTS;§4.3 schema 全量同步,加入 §4.4 跨欄位語意驗證(`RATE_LIMIT_TRUSTED_PROXIES` 在 prod 必填、access ≠ refresh secret);§5.2 安全等級表重排;§8 對應 `.env.example` 差距更新 |
| 0.4 | 2026-06-16 | §3.2 `DATABASE_URL` 改為衍生(不在 schema)— app 由 `composeDatabaseUrl(DB_*)` 注入 `datasourceUrl`,Prisma CLI 走 env;§3.3 Redis 拆分 `REDIS_URL` → `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD`(對齊 §3.2 DB_* 模式,免 percent-encode);§3.7 新增 `RATE_LIMIT_DISABLED` kill switch;新增 §3.9 S3 Storage(spec 018)— `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT` / `S3_FORCE_PATH_STYLE` / `S3_PUBLIC_URL_BASE` / `S3_PRESIGN_TTL_SECONDS` / `S3_MAX_UPLOAD_BYTES` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`;§4.3 schema 範例同步;§4.4 加 AWS keys 成對驗證;§8 對應 `.env.example` 差距同步 |
| 0.5 | 2026-07-07 | 同步實作:§3.9 / §4.4 AWS 憑證規則改為「non-dev **必須留空**、用 ECS task role」(原文與 `post-validate.ts` 語意相反),並補「任一環境同空/同非空」規則;§4 載入機制由 `@fastify/env` 更正為自寫 loader(TypeBox schema + Ajv,`src/config/load.ts`,於 Fastify 建構前 `loadConfig()` 呼叫),§4.2 將 `@fastify/env` 移入未採用方案,§4.3 register 範例改為 `loadConfig()`;§4.3 `GOOGLE_CALLBACK_URL` / `OIDC_DISCOVERY_URL` 由 `format:'uri'` 更正為 `minLength:1` / 無 format;§4.3 `S3_MAX_UPLOAD_BYTES` 補 `minimum:1`;§7 驗證表更正為 `ConfigLoadError` / `ConfigValidationError`(語意錯誤冒泡至 bootstrap catch 才 `process.exit(1)`,無專屬缺漏 key 列印) |
