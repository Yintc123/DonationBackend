# Spec 002:`.env.example` 模板規格

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.2 |
| 日期 | 2026-06-13 |
| 適用範圍 | `backend/.env.example` |
| 相關 spec | `001-environment-config.md`(v0.2) |
| 相關 ADR | `docs/decisions/002-backend-framework.md`、`docs/decisions/003-database-postgresql.md` |

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

### 3.1 當前 `.env.example`(commit `1a492a6`)

| Section | Keys |
|---|---|
| Server | `PORT`, `HOST`, `LOG_LEVEL` |
| Database | `DATABASE_URL` |
| JWT | `JWT_SECRET` |
| Google OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` |
| Redis | `REDIS_URL` |

### 3.2 缺漏 key / 待替換(對照 spec 001 v0.2)

| 動作 | Key | Section | 來源 spec | 理由 |
|---|---|---|---|---|
| 新增 | `NODE_ENV` | Server | §3.1 | 必填,影響日誌格式與錯誤回應細節 |
| 新增 | `JWT_EXPIRES_IN` | JWT | §3.4 | 非必填,寫出有助新人理解 token 生命期 |
| 新增 | `CORS_ORIGIN` | CORS(新區塊) | §3.6 | 必填,backend 只接受 BFF origin |
| **替換** | `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` / `DB_SCHEMA` / `DB_SSL_MODE` / `DB_CONNECTION_LIMIT` / `DB_POOL_TIMEOUT` + 衍生 `DATABASE_URL` | Database | §3.2(v0.2 拆分) | DB 改為多參數,`DATABASE_URL` 經 dotenv-expand 組合 |

> 「替換」=移除既有 `DATABASE_URL` 單一字串列,改為新格式。

### 3.3 目標檔案內容(草案 v0.2)

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
# percent-encoded here (e.g. "@" → "%40"). In stage/prod the
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

# === JWT ===

# Must be >= 32 characters; rotate per environment
JWT_SECRET="please-change-me-to-a-long-random-string"
# Access token lifetime, accepts ms / @fastify/jwt format (optional)
JWT_EXPIRES_IN=7d

# === Google OAuth 2.0 ===

GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
# Must match the redirect URI registered in Google Cloud Console
GOOGLE_CALLBACK_URL="http://localhost:3001/auth/google/callback"

# === Redis ===

REDIS_URL="redis://localhost:6379"

# === CORS ===

# Comma-separated list of allowed BFF origins (no wildcards in prod)
CORS_ORIGIN="http://localhost:3000"
```

> 此草案經 review 通過後,作為實作目標。
> 註:`DB_*` 為 authoritative,`DATABASE_URL` 為 dotenv-expand 衍生;順序刻意把派生值放在被引用變數之後,確保展開正確。
> JWT 區塊待 ADR 004(access + refresh 雙 token)落地後再拆,本版暫保留單一 `JWT_SECRET` / `JWT_EXPIRES_IN`。

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
