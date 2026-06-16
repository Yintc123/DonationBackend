# Spec 002:`.env.example` 模板規格

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.4 |
| 日期 | 2026-06-16 |
| 適用範圍 | `backend/.env.example` |
| 相關 spec | `001-environment-config.md`(v0.4) |
| 相關 ADR | `docs/decisions/002-backend-framework.md`、`docs/decisions/003-database-postgresql.md`、`docs/decisions/004-auth-token-strategy.md` |

---

## 1. 目的

定義 `backend/.env.example` 的內容、格式與維護規則。`.env.example` 是「新開發者 clone repo 後要準備哪些設定」的**單一事實來源**,並作為設定面的契約文件:

- 凡 spec 001 §3 列出的環境變數,**必須**在本檔出現對應 key
- 凡本檔列出的 key,**必須**在 spec 001 §3 有說明
- 兩者不對齊時,以 spec 001 為準,本檔需修正

---

## 2. 格式規範

### 2.1 結構

```bash
# === SECTION NAME ===

# Optional: one-line description of the variable
KEY=default-value-for-dev
```

- 每段以 `# === XXX ===` 區塊標題分區,順序對齊 spec 001 §3
- 每個 key 上方一行**英文**註解描述用途(避免亂碼)
- 值一律用 dev 環境的合理預設或 placeholder

### 2.2 必填 / 非必填標示

- **必填**:不加額外標記,值給合理 dev 預設
- **非必填**:註解結尾加 `(optional)`,值給 spec 001 §3 列的預設值

### 2.3 Secret 處理

- 任何高敏感欄位(spec 001 §5.2 列為「高敏感」者)**不可放真實值**,使用明顯的 placeholder:
  - `"please-change-me-to-a-long-random-string"`
  - `"your-google-client-secret"`
- placeholder 須一眼可辨識為「未設定」,避免被誤當成真實 secret

### 2.4 引號

- 含特殊字元或空白的值用 `"..."` 包住
- 純英數值不加引號(reduces noise)
- URL 一律加引號(冒號 / 斜線視覺干擾)

---

## 3. 當前狀態 vs 目標狀態

### 3.1 當前 `.env.example`(commit `caa7b3d`)

| Section | Keys |
|---|---|
| Server | `NODE_ENV`, `PORT`, `HOST`, `LOG_LEVEL` |
| Database | `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` / `DB_SCHEMA` / `DB_SSL_MODE` / `DB_CONNECTION_LIMIT` / `DB_POOL_TIMEOUT` / 衍生 `DATABASE_URL` |
| JWT | `JWT_SECRET`、`JWT_EXPIRES_IN` |
| Google OAuth | `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_CALLBACK_URL` |
| Redis | `REDIS_URL` |
| CORS | `CORS_ORIGIN` |

### 3.2 對照 spec 001 v0.3 的差距

| 動作 | Key(s) | Section | 來源 spec |
|---|---|---|---|
| **替換** | `JWT_SECRET` / `JWT_EXPIRES_IN` → `JWT_ACCESS_SECRET` / `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_SECRET` / `JWT_REFRESH_EXPIRES_IN` / `JWT_ISSUER` / `JWT_AUDIENCE` | JWT | spec 001 §3.4(ADR 004 落實) |
| 新增 | `OIDC_DISCOVERY_URL` | Google OAuth | spec 001 §3.5 |
| 新增(新區塊) | `PASSWORD_HASH_MEMORY_COST` / `PASSWORD_HASH_TIME_COST` / `PASSWORD_HASH_PARALLELISM` / `PASSWORD_MIN_LENGTH` / `LOGIN_LOCK_THRESHOLD` / `LOGIN_LOCK_WINDOW_SEC` | Password(新) | spec 001 §3.6 |
| 新增(新區塊) | `RATE_LIMIT_GLOBAL_PER_IP_LIMIT` / `RATE_LIMIT_GLOBAL_PER_IP_WINDOW_SEC` / `RATE_LIMIT_DEFAULT_LIMIT` / `RATE_LIMIT_DEFAULT_WINDOW_SEC` / `RATE_LIMIT_FAILURE_MODE` / `RATE_LIMIT_TRUSTED_PROXIES` | Rate Limit(新) | spec 001 §3.7 |
| 新增 | `CORS_PREFLIGHT_MAX_AGE_SEC` / `HSTS_MAX_AGE_SEC` / `HSTS_INCLUDE_SUBDOMAINS` / `HSTS_PRELOAD` | CORS / Security(擴充) | spec 001 §3.8 |

### 3.3 目標檔案內容(草案 v0.3)

```bash
# === Server ===

# Runtime environment: development | staging | production
NODE_ENV=development
PORT=3001
HOST=0.0.0.0
# pino log level: fatal | error | warn | info | debug | trace
LOG_LEVEL=info

# === Database (Prisma / PostgreSQL) ===
#
# Authoritative values are the discrete DB_* vars below.
# DATABASE_URL is composed via dotenv-expand so Prisma CLI
# (which only reads DATABASE_URL) keeps working unchanged.
#
# If DB_PASSWORD contains any of @ : / ? # it MUST be
# percent-encoded here (e.g. "@" -> "%40"). In stage/prod the
# composeDatabaseUrl helper handles encoding automatically.

DB_HOST=localhost
DB_PORT=5432
DB_USER=user
DB_PASSWORD=password
DB_NAME=jkodonation_dev
DB_SCHEMA=public
# Optional: '', 'require', 'verify-ca', 'verify-full' (prod usually 'require')
DB_SSL_MODE=
# Optional: leave empty to use Prisma's default
DB_CONNECTION_LIMIT=
DB_POOL_TIMEOUT=

DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=${DB_SCHEMA}"

# === JWT (access + refresh per ADR 004) ===
#
# Both secrets MUST be at least 32 characters AND differ from
# each other. Rotate per environment.

JWT_ACCESS_SECRET="please-change-me-to-a-long-random-access-secret"
JWT_ACCESS_EXPIRES_IN=3h
JWT_REFRESH_SECRET="please-change-me-to-a-different-long-refresh-secret"
JWT_REFRESH_EXPIRES_IN=30d
# JWT issuer/audience for iss/aud claims
JWT_ISSUER="http://localhost:3001"
# Optional: defaults to JWT_ISSUER when empty
JWT_AUDIENCE=

# === Google OAuth 2.0 / OIDC ===

GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
# Must match the redirect URI registered in Google Cloud Console.
# Note: per spec 007 §2.4 the callback is hosted by the BFF,
# not by the backend. Backend forwards it to Google during
# the token exchange step.
GOOGLE_CALLBACK_URL="http://localhost:3000/api/auth/google/callback"
# Rarely needs changing
OIDC_DISCOVERY_URL="https://accounts.google.com/.well-known/openid-configuration"

# === Password (Argon2id, spec 008) ===
#
# Defaults follow OWASP 2025 baseline. Increase memory_cost
# first if hashing is too fast on your hardware; tune time_cost
# second. Login re-hashes existing accounts silently when these
# values change (spec 008 §3.1).

PASSWORD_HASH_MEMORY_COST=19456
PASSWORD_HASH_TIME_COST=2
PASSWORD_HASH_PARALLELISM=1
PASSWORD_MIN_LENGTH=8

# Login lockout
LOGIN_LOCK_THRESHOLD=10
LOGIN_LOCK_WINDOW_SEC=900

# === Redis (v0.4 — discrete params, mirrors DB_*) ===
#
# Use REDIS_PASSWORD="" for unauthenticated local / LocalStack
# Redis. In staging / prod it MUST be non-empty.

REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# === Rate Limit (spec 010) ===

# v0.4 — global kill switch. Set to "true" ONLY for demo/local
# bypass; prod deploys must keep this false (the rateLimitPlugin
# refuses to register its preHandler when this is true).
RATE_LIMIT_DISABLED=false
RATE_LIMIT_GLOBAL_PER_IP_LIMIT=600
RATE_LIMIT_GLOBAL_PER_IP_WINDOW_SEC=60
RATE_LIMIT_DEFAULT_LIMIT=120
RATE_LIMIT_DEFAULT_WINDOW_SEC=60
# 'closed' (recommended) | 'open' — behaviour when Redis is unreachable
RATE_LIMIT_FAILURE_MODE=closed
# Comma-separated IPs/CIDRs of trusted BFF / load balancer.
# REQUIRED in staging/production — empty there fails fast at
# startup (per spec 001 §4.4 cross-field validation) to prevent
# X-Forwarded-For spoofing.
RATE_LIMIT_TRUSTED_PROXIES=

# === CORS / Security Headers (spec 012) ===

# Comma-separated list of allowed BFF origins (no wildcards in prod)
CORS_ORIGIN="http://localhost:3000"
CORS_PREFLIGHT_MAX_AGE_SEC=600

# HSTS (max-age = 365 days). Preload disabled by default; only
# enable after domain has been live on HTTPS for ~1 month.
HSTS_MAX_AGE_SEC=31536000
HSTS_INCLUDE_SUBDOMAINS=true
HSTS_PRELOAD=false

# === S3 Storage (spec 018, v0.4) ===
#
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY must be BOTH empty
# (dev uses local AWS profile / LocalStack) or BOTH non-empty
# (staging/prod inject via secret manager). post-validate.ts
# fails fast if exactly one is set.

S3_BUCKET=jkodonation-dev
S3_REGION=ap-northeast-1
# Empty = real AWS. Use http://localhost:4566 for LocalStack,
# or the R2/MinIO endpoint URL for those backends.
S3_ENDPOINT=
# Strict 'true' parsing — anything else is treated as false.
S3_FORCE_PATH_STYLE=false
# Optional CDN base URL. Empty = use the default url() rule from spec 018.
S3_PUBLIC_URL_BASE=
S3_PRESIGN_TTL_SECONDS=300
S3_MAX_UPLOAD_BYTES=5242880

AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
```

> 此草案經 review 通過後,作為實作目標。
> 註:`DB_*` 為 authoritative,`DATABASE_URL` 為 dotenv-expand 衍生;順序刻意把派生值放在被引用變數之後,確保展開正確。

---

## 4. 同步機制

### 4.1 觸發條件

以下情況必須同步更新 `.env.example`:

- spec 001 §3 新增 / 刪除 / 重新命名 env key
- spec 001 §3.x 改變必填 / 非必填屬性
- dev 預設值改變(例:port 從 3001 改成 3000)
- 任何 ADR 改變設定載入機制

### 4.2 棄用流程

刪除 key 不可直接移除,必須:

1. 在 key 上方註記 `# DEPRECATED in v0.X — will be removed in v0.Y`
2. 至少保留一個版本(讓既有開發者有時間遷移)
3. 下一版才實際刪除

### 4.3 Review 檢查清單

PR review 時,reviewer 須確認:

- [ ] spec 001 §3 與 `.env.example` keys 一一對應(沒有單邊變更)
- [ ] 新增 secret 級欄位用 placeholder,不是真實值
- [ ] 區塊順序與 spec 001 §3 一致
- [ ] 英文註解語意清楚

---

## 5. 驗證策略

### 5.1 目前(人工)

- code review 時人工比對 `.env.example` 與 spec 001
- 啟動服務時 `@fastify/env` schema 驗證會抓出 `.env` 缺漏,但**不會**檢查 `.env.example` 本身是否完整

### 5.2 未來(可選自動化)

- **`dotenv-linter`**:靜態檢查 key 命名、重複、空值
- **unit test**:讀 `.env.example`,parse 出 keys,比對 `@fastify/env` schema 的 `required` 與 `properties`,缺漏即 fail
  - 屬於本專案 TDD 精神的「設定面測試」
  - 待 spec 001 §4 的 schema 落地後再寫

兩者皆屬 nice-to-have,不阻擋本 spec 通過。

---

## 6. 安全提醒

- **嚴禁** commit 真實的 `.env`(已由 `.gitignore` 屏蔽,但仍要警覺)
- 若不慎將真實 secret 推上 git:
  1. **立即 revoke 該 token / 改 password**(優先於清 git history)
  2. 再清 git history(`git filter-repo` 或 BFG)
  3. force push 並通知共同開發者重新 clone
- code review 時若見 `.env.example` 出現非 placeholder 樣式的字串(看起來像真 token),blocking comment

---

## 7. 開放問題

- 是否引入多個 `.env.example` 變體(例:`.env.example.staging`)?目前**不需要**,各環境設定差異由部署平台管理(spec 001 §2),`.env.example` 僅服務 dev
- 是否需要 `.env.example.test`?待 vitest 落地後評估;傾向用 `vitest` 的 `globalSetup` 注入測試專用環境變數,而非另一份範本

---

## 8. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-13 | 初版;定義格式、列出當前缺漏(`NODE_ENV` / `JWT_EXPIRES_IN` / `CORS_ORIGIN`)、提供目標草案 |
| 0.2 | 2026-06-13 | 同步 spec 001 v0.2:Database 區塊改為 `DB_*` 9 個拆分參數 + dotenv-expand 衍生 `DATABASE_URL`;備註特殊字元 percent-encoding 規則 |
| 0.3 | 2026-06-13 | 同步 spec 001 v0.3:JWT 拆 access + refresh(ADR 004);新增 OIDC discovery;新增 Password / Login lock 區塊(Argon2);新增 Rate Limit 區塊(`RATE_LIMIT_TRUSTED_PROXIES` 提醒 prod 必填);CORS 擴充 HSTS;§3.1 反映當前實際 `.env.example` 狀態(commit `caa7b3d`);§3.2 改為「差距對照」表;§3.3 草案完整重寫 |
| 0.4 | 2026-06-16 | 同步 spec 001 v0.4:Redis 拆 `REDIS_URL` → `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD`;Rate Limit 新增 `RATE_LIMIT_DISABLED` kill switch;新增 S3 Storage 區塊(`S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT` / `S3_FORCE_PATH_STYLE` / `S3_PUBLIC_URL_BASE` / `S3_PRESIGN_TTL_SECONDS` / `S3_MAX_UPLOAD_BYTES` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`);`DATABASE_URL` 維持 dotenv-expand 衍生供 Prisma CLI(app 不再讀,見 spec 001 v0.4 §3.2.2) |
