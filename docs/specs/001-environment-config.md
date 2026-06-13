# Spec 001:環境設定(Environment Configuration)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.1 |
| 日期 | 2026-06-13 |
| 適用範圍 | `backend/` |
| 相關 ADR | `docs/decisions/002-backend-framework.md` |

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

| Key | 必填 | dev 預設 | stage / prod | 說明 |
|---|---|---|---|---|
| `DATABASE_URL` | ✅ | `postgresql://user:password@localhost:5432/jkodonation?schema=public` | 各環境獨立 DB,connection string 由 secret manager 注入 | Prisma 連線字串 |

規則:
- **三環境必須使用獨立資料庫**,絕不共用
- connection string 含密碼,屬 secret 等級
- 切換環境時 Prisma migration 必須先在 stage 驗證再上 prod

### 3.3 Redis

| Key | 必填 | dev 預設 | stage / prod | 說明 |
|---|---|---|---|---|
| `REDIS_URL` | ✅ | `redis://localhost:6379` | 各環境獨立 instance | 用於 cache / JWT blacklist / rate-limit |

規則:
- 三環境獨立 Redis instance,避免 cache 互相污染
- 若 stage/prod 啟用 ACL,connection string 屬 secret

### 3.4 JWT

| Key | 必填 | dev 預設 | stage / prod | 說明 |
|---|---|---|---|---|
| `JWT_SECRET` | ✅ | 隨機 32+ 字元 | 各環境獨立、≥ 32 字元、由 secret manager 注入 | 簽章密鑰 |
| `JWT_EXPIRES_IN` | | `7d` | `7d` | access token 有效期(`@fastify/jwt` 接受的格式) |

規則:
- 三環境的 `JWT_SECRET` 必須不同,以免一環境外洩波及全部
- 長度下限 32(由 schema `minLength` 強制)
- 不可寫入 log

### 3.5 Google OAuth 2.0

| Key | 必填 | dev 預設 | stage / prod | 說明 |
|---|---|---|---|---|
| `GOOGLE_CLIENT_ID` | ✅ | dev OAuth client id | 各環境獨立 client | 由 Google Cloud Console 建立 |
| `GOOGLE_CLIENT_SECRET` | ✅ | dev OAuth client secret | 各環境獨立 client | secret,不可進 git |
| `GOOGLE_CALLBACK_URL` | ✅ | `http://localhost:3001/auth/google/callback` | `https://api.{env}.<domain>/auth/google/callback` | 必須與 Google Console 註冊的 redirect URI 完全一致 |

規則:
- **每個環境建立獨立 Google OAuth client**,callback URL 不同
- dev 的 callback URL 用 `http://localhost:*`,Google Console 允許
- stage/prod 必須走 `https`

### 3.6 CORS

| Key | 必填 | dev 預設 | stage / prod | 說明 |
|---|---|---|---|---|
| `CORS_ORIGIN` | ✅ | `http://localhost:3000` | 對應環境的 BFF URL | 允許的前端 origin,逗號分隔多筆 |

規則:
- backend 只接受 BFF 來源(不直接面對瀏覽器);wildcard `*` 嚴禁用於 prod
- credentials 模式啟用,因此 origin 必須具體列出

## 4. 設定載入機制

採用 **[`@fastify/env`](https://github.com/fastify/fastify-env)** 搭配 JSON Schema 驗證。

### 4.1 理由

- 與 Fastify 一致的 schema-driven 風格(呼應 ADR 002)
- 啟動時驗證,缺漏立即 fail-fast,錯誤訊息指明缺哪個 key
- 型別自動推導至 `fastify.config`,使用端 TS 完整
- 內建 `dotenv: true` 選項,dev 模式自動讀 `.env`

### 4.2 替代方案(已評估,不採用)

- `dotenv` + 手寫 validate:需自行寫驗證碼,易遺漏
- `@sinclair/typebox` + 自寫 loader:功能等價但 boilerplate 多
- `zod` + `dotenv`:與 Fastify schema 風格不一致

### 4.3 結構草案

```ts
// src/config/schema.ts
export const configSchema = {
  type: 'object',
  required: [
    'NODE_ENV', 'PORT',
    'DATABASE_URL', 'REDIS_URL',
    'JWT_SECRET',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL',
    'CORS_ORIGIN',
  ],
  properties: {
    NODE_ENV:     { type: 'string', enum: ['development', 'staging', 'production'] },
    PORT:         { type: 'number', default: 3001 },
    HOST:         { type: 'string', default: '0.0.0.0' },
    LOG_LEVEL:    { type: 'string', enum: ['fatal','error','warn','info','debug','trace'], default: 'info' },
    DATABASE_URL: { type: 'string', minLength: 1 },
    REDIS_URL:    { type: 'string', minLength: 1 },
    JWT_SECRET:   { type: 'string', minLength: 32 },
    JWT_EXPIRES_IN: { type: 'string', default: '7d' },
    GOOGLE_CLIENT_ID:     { type: 'string', minLength: 1 },
    GOOGLE_CLIENT_SECRET: { type: 'string', minLength: 1 },
    GOOGLE_CALLBACK_URL:  { type: 'string', format: 'uri' },
    CORS_ORIGIN:  { type: 'string', minLength: 1 },
  },
} as const

// src/app.ts(片段)
await app.register(fastifyEnv, {
  schema: configSchema,
  dotenv: true,         // dev 從 .env 讀
  confKey: 'config',    // app.config.JWT_SECRET 取用
})
```

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
| 高敏感 | `JWT_SECRET`, `GOOGLE_CLIENT_SECRET`, `DATABASE_URL` 密碼段 | secret manager,定期輪替 |
| 中敏感 | `GOOGLE_CLIENT_ID`, `REDIS_URL` 含密碼時 | 環境變數即可 |
| 低敏感 | `PORT`, `LOG_LEVEL`, `CORS_ORIGIN`, `GOOGLE_CALLBACK_URL` | 環境變數 / 設定檔皆可 |

## 6. 命名與相依

- 變數採全大寫 + `_` 分隔(POSIX 慣例)
- 同類前綴:`GOOGLE_*`、`JWT_*`、`REDIS_*`、`DATABASE_*`
- 跨環境必須對應一致:不可某環境用 `DB_URL`、另一個用 `DATABASE_URL`
- 棄用變數需在 `.env.example` 註解 `# DEPRECATED: 將於 vX.Y 移除` 至少一個版本後再刪除

## 7. 啟動驗證

| 階段 | 行為 | 失敗動作 |
|---|---|---|
| `register(fastifyEnv)` | JSON Schema 驗證 | throw,server 不啟動 |
| 額外語意驗證 | 例:`prod` 環境下 `CORS_ORIGIN` 不可含 `localhost` | `process.exit(1)` 並 log 缺漏 key 名稱 |
| Smoke | `GET /health` 回 200 | 部署 pipeline 視為失敗 |

錯誤訊息需指明:
- 缺漏的 key 名稱
- 該 key 期望的型別 / 格式
- 應到何處設定(`.env` for dev、平台 env 設定為 stage/prod)

## 8. `.env.example` 與本 spec 的對應

- 目前 `.env.example` 涵蓋 §3.2 ~ §3.6 大部分 key
- 待補:`NODE_ENV`、`JWT_EXPIRES_IN`、`CORS_ORIGIN`(本 spec 通過後同步更新)

## 9. 開放問題

- stage/prod 實際部署平台尚未決定(Vercel / Railway / Fly.io / 自架),會影響 secret 載入細節與 `GOOGLE_CALLBACK_URL` 的網域命名
- 是否引入 feature flag 機制(目前無此需求,留作未來擴充)
- token 輪替(rotation)策略:JWT 短期 + refresh token,或單一長期 JWT,待 auth spec 決定
- 是否需要 per-tenant 設定(目前單租戶,暫不考慮)

## 10. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-13 | 初版 |
