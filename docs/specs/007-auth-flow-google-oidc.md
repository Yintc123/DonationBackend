# Spec 007:Auth Flow — Identity 模型 + Google OAuth 2.0 / OIDC

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.5 |
| 日期 | 2026-06-13 |
| 適用範圍 | `backend/src/routes/auth/*`、`backend/src/lib/auth/*` |
| 相關 ADR | `docs/decisions/002-backend-framework.md`(BFF 邊界)、`docs/decisions/004-auth-token-strategy.md`(access + refresh) |
| 相關 spec | `001-environment-config.md`、`004-logger-module.md`、`005-error-handling.md`、`006-redis-module.md`(`auth` tier)、`008-auth-flow-password.md`(帳號密碼登入,共用本檔 §10 身分模型) |

---

## 1. 目的與範圍

### 1.1 目的

定義 backend 的使用者驗證基礎與 Google OIDC 登入流程,涵蓋:

- **Identity 模型**:Account ↔ Credential 抽象,供 Google 與帳密(spec 008)共用
- 使用 **Google OAuth 2.0 + OIDC** 取得使用者身分
- **Authorization Code with PKCE** 防範授權碼攔截
- **state / nonce** 防範 CSRF 與 replay
- 驗證 Google **ID Token** 並對應至 Account
- 落實 ADR 004 的雙 token 策略(access 3h + refresh 30d)、rotation、replay detection
- 登出與全裝置登出
- **手動連結**(已登入者將 Google 加為額外 credential)

### 1.2 In scope

- Identity 模型(本檔 §10),供本檔與 spec 008 共用
- Google as IdP(OIDC discovery、JWKS、ID Token 驗證)
- Backend 對外端點(BFF → backend 的 JSON API)
- OAuth session 短暫狀態管理(Redis `auth` tier)
- Token 發放、refresh、撤銷
- 與 BFF 的責任切分

### 1.3 Out of scope(後續或不做)

- 其他 OAuth provider(Facebook、Apple、GitHub) — 目前無需求,但 §10 識別模型已預留擴充
- 帳號密碼登入細節 — 由 **spec 008** 處理(共用 §10 身分模型)
- **Email 驗證流程** — 本期不做。Google 端的 `email_verified` 仍須為 true(§13.5);帳密註冊不寄驗證信
- **自動 account linking** — 不做。Google sign-in 若 email 已被其他 account 佔用,回 409 要求使用者手動連結(§10.5)
- 多因素(MFA / TOTP) — 後續評估
- BFF 內部 session cookie 細節 — 由前端 spec 處理
- 細粒度權限 / RBAC — 後續業務 spec

---

## 2. 用戶端 / BFF / Backend 職責切分

### 2.1 拓樸

```
Browser ─(session cookie)─> Next.js BFF ─(JSON, Bearer JWT)─> Fastify Backend ─> Google IdP / Redis / DB
```

### 2.2 三方職責表

| 元件 | 負責 | 不負責 |
|---|---|---|
| **Browser** | 接收 BFF 的 302 redirect 到 Google;認證後被 Google 302 回 BFF callback | 解析 token、儲存 token、解析 ID token |
| **BFF (Next.js)** | 瀏覽器導向(302 to Google、302 back to app);保管 session cookie(httpOnly、secure、sameSite=lax);把 Google callback 收到的 `code` 與 backend session id 傳給 backend;將 backend 回的 JWT 收進自己的 session | 不持有 `GOOGLE_CLIENT_SECRET`;不直接驗證 Google ID token;不簽 backend 的 JWT |
| **Backend (Fastify)** | 產生 state / nonce / PKCE;與 Google 交換 code → tokens;**驗證 Google ID Token**;對應 user account;簽發/續期/撤銷自家 JWT(ADR 004) | 不做瀏覽器 redirect(全 JSON API);不持有 BFF session cookie 邏輯 |

### 2.3 為何 backend 不直接做 redirect

- Backend 與 BFF 對 client 是兩個來源,瀏覽器跨網域 redirect 會增加 cookie 同源問題與 SameSite 限制
- BFF 是瀏覽器層,本來就要處理 HTML / cookie,redirect 由它做最自然
- backend 保持純 JSON API,跟 ADR 002 一致

### 2.4 Google redirect URI 註冊在 BFF

- 在 Google Cloud Console 的 OAuth Client 中,redirect URI 設為 **BFF 的 callback URL**(例:`https://app.example.com/api/auth/google/callback`)
- Backend **不**被 Google 直接打;backend 只接收 BFF 傳來的 `code` 並做後續交換
- 這意味 `GOOGLE_CALLBACK_URL` 的「真正用途」是給 backend 在交換 token 時傳給 Google 做 redirect_uri 驗證(必須與註冊值一致,但 backend 不會生 redirect response)

---

## 3. 採用的 OAuth / OIDC 機制

### 3.1 標準

- **OAuth 2.0 Authorization Code Grant**(RFC 6749 §4.1)
- **PKCE**(RFC 7636,S256 method)
- **OpenID Connect Core 1.0**(取 ID Token,不打 `/userinfo`)

### 3.2 為什麼一定要 PKCE

- 即便我們有 `client_secret`(屬於 confidential client),PKCE 仍是業界 2026 的最佳實踐
- 防範 authorization code 在 BFF 與 backend 之間被攔截後重放
- 額外成本極低(一組 random + SHA256),沒有不開的理由

### 3.3 為什麼用 ID Token 而不打 `/userinfo`

- ID Token 已含 `sub` / `email` / `email_verified` / `name` / `picture`,足夠識別
- 少一次外呼,延遲低
- 簽章可驗,無需信任額外 endpoint
- `/userinfo` 留作未來「需取更多 profile」時再評估

### 3.4 為什麼不用 Google 的 refresh token

- ADR 004 已決定本服務發**自家 access + refresh**
- Google refresh token 用於「以使用者身分呼叫 Google API」;本服務不需(只需識別)
- 取得後即丟,避免額外保管 secret 的風險

---

## 4. Sign-in 流程

### 4.1 序列圖

```
Browser     BFF (Next.js)            Backend (Fastify)          Google
  │            │                          │                       │
  │  click     │                          │                       │
  │ "Sign in"  │                          │                       │
  ├──────────▶ │                          │                       │
  │            │  POST /auth/google/authorize-init                 │
  │            ├────────────────────────▶ │                       │
  │            │                          │ generate state/nonce/ │
  │            │                          │ code_verifier;       │
  │            │                          │ store in Redis        │
  │            │                          │ jkod:auth:oauth:{sid} │
  │            │ 200 { sid, authUrl }     │                       │
  │            │ ◀────────────────────────┤                       │
  │  302 ──▶ authUrl                      │                       │
  │            │                          │                       │
  │            │                       302 ──▶ Google login UI    │
  │ ◀────────────────────────────────────────────────────────────│
  │  user authenticates                                            │
  │            │                          │                       │
  │  302 to BFF callback?code=...&state=  │                       │
  │            ◀──────────────────────────────────────────────────┤
  │            │                          │                       │
  │            │ POST /auth/google/exchange { sid, code, state }  │
  │            ├────────────────────────▶ │                       │
  │            │                          │ load Redis by sid;    │
  │            │                          │ verify state matches  │
  │            │                          │                       │
  │            │                          │ POST /token (code+verifier)
  │            │                          ├──────────────────────▶│
  │            │                          │ ◀ id_token, access_t │
  │            │                          │ verify ID token       │
  │            │                          │ (sig, iss, aud, exp,  │
  │            │                          │  nonce match)         │
  │            │                          │ upsert user account   │
  │            │                          │ mint JWT (access +    │
  │            │                          │ refresh) per ADR 004  │
  │            │                          │ store refresh in Redis│
  │            │                          │ jkod:auth:refresh:{} │
  │            │ 200 { access, refresh, ttl } │                   │
  │            │ ◀────────────────────────┤                       │
  │            │ set BFF session cookie   │                       │
  │  302 to app│                          │                       │
  │ ◀──────────┤                          │                       │
```

### 4.2 步驟細節

#### Step 1: BFF → Backend `POST /auth/google/authorize-init`

- BFF 帶 nothing(或一個 `returnTo` 供登入後跳回)
- Backend 生:
  - `sid`:Redis key 用的 OAuth session id(UUID v4)
  - `state`:CSRF token(32 bytes random,base64url)
  - `nonce`:OIDC nonce(32 bytes random,base64url)
  - `code_verifier`:PKCE verifier(64 bytes random,base64url)
  - `code_challenge` = `BASE64URL(SHA256(code_verifier))`
- 寫入 Redis:`jkod:auth:oauth:{sid}` Hash `{ state, nonce, codeVerifier, returnTo? }`,TTL **600 秒**(10 分鐘)
- 組 `authUrl`(見 §4.3)
- 回 `{ sid, authUrl }`

#### Step 2: BFF 302 to `authUrl`

由 BFF 處理,backend 不參與。

#### Step 3: Google → BFF callback `?code=...&state=...`

由 BFF 接收,backend 不參與。

#### Step 4: BFF → Backend `POST /auth/google/exchange`

Body:
```json
{ "sid": "...", "code": "...", "state": "..." }
```

Backend 處理(若任一步失敗,見 §12):
1. 從 Redis 用 `sid` 讀回 `state` / `nonce` / `codeVerifier` / `returnTo`;**不存在 → 401 (`AUTH_OAUTH_SESSION_INVALID`)**
2. 比對 body 的 `state` 與 Redis 的 `state`(timing-safe 比較);**不符 → 401 (`AUTH_STATE_MISMATCH`)**
3. **立即 DEL Redis 該 key**(one-shot,防止 sid 重用)
4. 呼叫 Google `POST https://oauth2.googleapis.com/token`:
   - `grant_type=authorization_code`
   - `code` / `code_verifier` / `client_id` / `client_secret` / `redirect_uri`(必須與 Google Console 註冊一致)
5. 取回 `id_token`(以及 `access_token` / `expires_in` / 可能 `refresh_token`——後兩者丟棄)
6. 驗證 `id_token`(§8)
7. 取得 `sub` / `email` / `email_verified`
8. 對應 Account(§10.3):查 GoogleCredential → 有則登入;無則檢查 email 是否被佔用,被佔用 → 409;否則建立 Account + GoogleCredential
9. 簽發自家 access + refresh(§11)
10. 將 refresh 存 Redis `auth` tier(§11.3、spec 006 §15.1)
11. 回應:

```json
{
  "accessToken": "<jwt>",
  "accessExpiresIn": 10800,
  "refreshToken": "<jwt>",
  "refreshExpiresIn": 2592000,
  "tokenType": "Bearer",
  "returnTo": "/dashboard"
}
```

### 4.3 Authorize URL 組裝

```
https://accounts.google.com/o/oauth2/v2/auth
  ?response_type=code
  &client_id={GOOGLE_CLIENT_ID}
  &redirect_uri={REDIRECT_URI_REGISTERED_IN_CONSOLE}
  &scope=openid%20email%20profile
  &state={state}
  &nonce={nonce}
  &code_challenge={code_challenge}
  &code_challenge_method=S256
  &prompt=select_account
  &access_type=online
```

- `scope=openid email profile` — 取 ID Token + email + 基本 profile
- `access_type=online` — 不要 refresh token(我們不需要)
- `prompt=select_account` — 每次顯示帳號選擇器(UX 較友善;改為 `consent` 強制重同意)
- 不傳 `hd` / `login_hint`(無企業限制)

---

## 5. Refresh 流程

### 5.1 流程

```
BFF → Backend  POST /auth/refresh   Authorization: Bearer <refresh-jwt>
                                     (或在 body 中 { refreshToken })

Backend:
  verify JWT signature + type=refresh + exp
  parse jti (= Redis tokenId)
  GET jkod:auth:refresh:{jti}
    not found            → 401 AUTH_REFRESH_REVOKED
    found and used=true  → REPLAY DETECTED:
                            SMEMBERS jkod:auth:refresh:user:{userId}
                            DEL each tokenId
                            DEL the SET
                            log audit event auth_refresh_replay
                            → 401 AUTH_REFRESH_REPLAY
    found and used=false →
      mark used=true (HSET) with same TTL
      generate new refresh tokenId + JWT
      generate new access JWT
      store new refresh in Redis + add to user's SET
      → 200 { accessToken, refreshToken, ... }
```

### 5.2 規則

- refresh JWT 自己也帶簽章與 exp,**雙重防線**:Redis 撤銷 + JWT 過期
- replay detection:見過已 used 的 token 視為竊取訊號,**撤銷該 user 全部 refresh**(ADR 004 §「為什麼 rotation + replay detection」)
- 新 refresh 的 TTL 從**現在**重新算 30d(滑動視窗);若不希望可改為「= 舊 token 剩餘壽命」,本 spec 採滑動視窗
- **不**回寫舊 token 內容到 client;舊 token 在 client 端應立即覆蓋

### 5.3 接受位置

- 預設**只接受** `Authorization: Bearer <refresh-jwt>`
- 不接受 cookie(避免 backend 處理 cookie,呼應 §2.2)
- BFF 從自己的 session cookie 取出 refresh,放在 Bearer header

---

## 6. Logout 與 Logout-all

### 6.1 `POST /auth/logout`

`Authorization: Bearer <access-jwt>`(可附 `refreshToken` in body)

Backend:
1. 驗 access JWT,取 `jti` 與 `userId`
2. 加入 access blacklist:`SET jkod:auth:blacklist:{jti} 1 EX <剩餘壽命>`
3. 若 body 帶 refresh,讀 refresh jti,`DEL jkod:auth:refresh:{rJti}` 並 `SREM user set`
4. log audit event `auth_logout`
5. 回 `204 No Content`

### 6.2 `POST /auth/logout-all`

`Authorization: Bearer <access-jwt>`

Backend:
1. 驗 access JWT,取 `userId`
2. `SMEMBERS jkod:auth:refresh:user:{userId}` → 逐個 `DEL`
3. `DEL jkod:auth:refresh:user:{userId}`
4. 將當前 access 加入 blacklist(其他 active access 因為 stateless 無法主動撤,等過期或 client 重新驗證)
5. log audit event `auth_logout_all`
6. 回 `204 No Content`

### 6.3 RP-initiated Logout(OIDC)

- 本 spec **不**呼叫 Google 的 OIDC end_session endpoint
- 使用者只是登出本服務,不影響 Google 帳號狀態(符合一般 UX 預期)

---

## 7. 端點規格

> Path 前綴與版本由 API 公開規格 spec 統一(預設 `/v1`),本 spec 寫相對路徑。

### 7.1 `POST /auth/google/authorize-init`

| 項目 | 內容 |
|---|---|
| 認證 | 不需要(`intent=login`,預設);`intent=link` 時必須帶 `Authorization: Bearer <access-jwt>` |
| Query | `?intent=login` 或 `?intent=link`(預設 `login`) |
| Body | `{ "returnTo"?: string }`(僅 `login`) |
| 200 Response | `{ "sid": "<uuid>", "authUrl": "<google url>" }` |
| Errors | 401 (`UNAUTHORIZED`,僅 `link`)、500 (`INTERNAL_ERROR`) |

### 7.2 `POST /auth/google/exchange`

| 項目 | 內容 |
|---|---|
| 認證 | 不需要(預設,`login` intent);`link` intent 時 sid 對應的 session 內已綁定 accountId,exchange 仍需 `Authorization: Bearer <access-jwt>` 並驗證 jwt.accountId 與 session.accountId 一致 |
| Body | `{ "sid": "<uuid>", "code": "<string>", "state": "<string>" }` |
| 200 Response(`login`) | `{ accessToken, accessExpiresIn, refreshToken, refreshExpiresIn, tokenType: "Bearer", returnTo? }` |
| 204 Response(`link`) | (no body) — 不換發 token |
| Errors | 401 (`AUTH_OAUTH_SESSION_INVALID`、`AUTH_STATE_MISMATCH`、`AUTH_ID_TOKEN_INVALID`、`AUTH_EMAIL_UNVERIFIED`)、409 (`AUTH_EMAIL_OWNED_BY_OTHER_ACCOUNT`、`AUTH_GOOGLE_ALREADY_LINKED`、`AUTH_CREDENTIAL_EXISTS`)、400 (`VALIDATION_FAILED`)、502 (`UPSTREAM_FAILURE`)、504 (`UPSTREAM_TIMEOUT`) |

### 7.3 `POST /auth/refresh`

| 項目 | 內容 |
|---|---|
| 認證 | `Authorization: Bearer <refresh-jwt>` |
| Body | (空) |
| 200 Response | 同 §7.2(login) |
| Errors | 401 (`AUTH_TOKEN_EXPIRED`、`AUTH_REFRESH_REVOKED`、`AUTH_REFRESH_REPLAY`、`UNAUTHORIZED`) |

### 7.4 `POST /auth/logout`

| 項目 | 內容 |
|---|---|
| 認證 | `Authorization: Bearer <access-jwt>` |
| Body | `{ "refreshToken"?: string }` |
| 204 Response | (no body) |
| Errors | 401 (`UNAUTHORIZED`、`AUTH_TOKEN_EXPIRED`) |

### 7.5 `POST /auth/logout-all`

| 項目 | 內容 |
|---|---|
| 認證 | `Authorization: Bearer <access-jwt>` |
| Body | (空) |
| 204 Response | (no body) |
| Errors | 同 §7.4 |

> 帳密相關端點(`/auth/register`、`/auth/login`、`/auth/password/change`) 由 spec 008 定義。

---

## 8. ID Token 驗證規則

### 8.1 必驗項目

| 項目 | 規則 |
|---|---|
| 簽章 | 用 Google JWKS 公鑰驗證(kid 對應)。函式庫:`jose` |
| `iss` | 等於 `https://accounts.google.com` 或 `accounts.google.com`(兩者皆 Google 允許) |
| `aud` | 等於 `GOOGLE_CLIENT_ID`(精確比對) |
| `exp` | 大於現在(允許 ±60s clock skew) |
| `iat` | 不大於現在 + 60s(防未來 token) |
| `nonce` | 等於 Redis 內存的 nonce(timing-safe 比對) |
| `email_verified` | 必須為 `true`,否則拒絕(防 unverified email 接管) |
| `email` | 必須存在(本服務用作主要識別 fallback) |
| `sub` | 必須存在(主要識別欄位) |

### 8.2 JWKS 取得與快取

- Endpoint:`https://www.googleapis.com/oauth2/v3/certs`(可從 OIDC discovery 動態取)
- **OIDC discovery**:`https://accounts.google.com/.well-known/openid-configuration`,啟動時抓一次並 cache;`jwks_uri` 從中讀
- JWKS 本身依 `Cache-Control` header cache(通常 1h);過期重抓
- 若驗證時 `kid` 不在 cache,**強制重抓**一次再失敗才拒絕(處理 key rotation)
- 快取放 in-memory(不入 Redis;每 instance 各自抓即可,流量極低)

### 8.3 函式庫

採 **`jose`** (`pnpm add jose`):

- 業界主流、無已知 CVE、支援 jwks remote set + cache + rotation
- 比手寫 RS256 驗證安全

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose'
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))

const { payload } = await jwtVerify(idToken, JWKS, {
  issuer: ['https://accounts.google.com', 'accounts.google.com'],
  audience: GOOGLE_CLIENT_ID,
  clockTolerance: 60,
})
// 額外驗 nonce / email_verified(jose 不管這些)
```

---

## 9. State / Nonce / PKCE 管理

### 9.1 儲存

- 全部存 Redis `auth` tier(spec 006 §5)
- Key:`jkod:auth:oauth:{sid}`
- Value:Hash `{ state, nonce, codeVerifier, returnTo? }`
- TTL:**600 秒**(10 分鐘);超時即視為失效,user 重新發起
- 一次性:exchange 成功後**立即 DEL**

### 9.2 產生規則

| 欄位 | 長度 | 編碼 | 來源 |
|---|---|---|---|
| `sid` | UUID v4 | hex | `crypto.randomUUID()` |
| `state` | 32 bytes | base64url | `crypto.randomBytes(32)` |
| `nonce` | 32 bytes | base64url | `crypto.randomBytes(32)` |
| `code_verifier` | 64 bytes | base64url | `crypto.randomBytes(64)` |
| `code_challenge` | (derived) | base64url | `SHA256(code_verifier)` |

### 9.3 比對

- 一律用 timing-safe 比對(`crypto.timingSafeEqual`)以防 timing attack
- `state` 不符時:401,不揭露細節原因(避免 oracle)

---

## 10. Identity 模型(共用基礎)

本節定義本服務的身分識別抽象,供本 spec(Google)與 spec 008(帳密)共用。具體欄位與資料表結構由資料模型 spec 擁有,**本節只規範形式**。

### 10.1 兩層結構:Account ↔ Credential(v0.5 — 加 role)

```
Account 1 ─────── N Credential
       │
       │ id, username? (unique), email? (unique),
       │ role (Int, default 1 — 見 §10.10),
       │ displayOrder, archivedAt?, deletedAt?,
       │ createdAt, updatedAt, lastLoginAt?, lastLoginType?
       │
       └── Credential (one row per authentication method)
           ├── PasswordCredential   (spec 008):  { accountId, hashedPassword, hashAlgo, updatedAt }
           └── GoogleCredential     (本 spec):    { accountId, externalId (= google sub), email, linkedAt }
```

- **Account**:服務內的「人」,唯一識別碼是 `id`(UUID)
- **Credential**:一次認證手段;一個 account 可有 0 或多筆 credential
- **`Account.username` / `Account.email` 皆 nullable + unique**;**至少需要其中一個**有值(應用層 register / linking 流程強制,DB 不設 CHECK constraint)。username 主要供帳密註冊用,email 主要供 Google sign-in 用;兩者並存也合法。pre-v0.4 既有 account 皆為 email-only,可後續補 username
- **Credential 由 `provider` 區分**(`'google'` / `'password'`),同一 account 同一 provider **最多一筆**(unique constraint on `(accountId, provider)`)
- **Google `sub`** 全域 unique(unique constraint on `(provider='google', externalId)`),確保同一 Google 帳號不能連結到多個 Account

> 上述名稱僅示範形式;table / column 命名由資料模型 spec 決定。

### 10.2 識別流程通則

| 流程 | 對應規則 |
|---|---|
| **Google sign-in** | 查 `(provider='google', externalId=sub)`;見 §10.3 |
| **帳密 sign-in** | 客戶端傳單一 `identifier` 欄位(v0.4),含 `@` → 查 `Account.email`,否則 → 查 `Account.username`,後比對 PasswordCredential(spec 008 §5) |
| **建立新 account** | 兩種來源(Google 首登 / 帳密註冊)皆走 §10.4 規則,擇一發起 |
| **手動連結** | 已登入 account 將另一 provider 的 credential 加入;見 §10.6 |

### 10.3 Google sign-in 對應流程

```
GoogleCred = lookup Credential by (provider='google', externalId=sub)

if GoogleCred exists:
  return GoogleCred.account                            ← 既有 user 登入

else:
  if Account exists with email = <google email>:
    → 409 AUTH_EMAIL_OWNED_BY_OTHER_ACCOUNT            ← 拒絕,提示手動連結(§10.6)

  else:
    create Account { email: <google email>, ... }
    create GoogleCredential { accountId, externalId: sub, email: <google email>, linkedAt: now }
    log audit event 'auth_account_created'
    return Account                                     ← 首次登入即註冊
```

### 10.4 建立新 Account 的規則

- 任何來源建立 Account 都必須:
  - 由 DB unique constraint 保護 `Account.email` 唯一
  - 在同一 transaction 內建立 Account + 對應 Credential(防止「Account 建好但 Credential 寫失敗」的孤兒)
  - 寫 audit log `auth_account_created`(內含 `accountId`、`provider`、`requestId`)
- 並發控制:兩個 request 同時對同一 email / 同一 Google sub 註冊 → 由 DB unique constraint 防止;失敗側可選擇 retry 走 §10.3 found 分支

### 10.5 Account Linking 政策(嚴格手動連結)

本服務**不**自動連結 account。具體規則:

| 情境 | 行為 |
|---|---|
| Google sign-in,sub 未連結、email 已被其他 Account 佔用 | **409 `AUTH_EMAIL_OWNED_BY_OTHER_ACCOUNT`**,訊息提示「請以原有方式登入後到設定頁連結 Google」 |
| 帳密註冊,email 已被其他 Account 佔用(無論該 Account 是 Google-only 或已有密碼) | **409 `AUTH_EMAIL_TAKEN`**(細節見 spec 008) |
| 已登入 Account 想加 Google 為 credential | 走 §10.6 link 流程 |
| 已登入 Account 想設定密碼 | 走 spec 008 §「設定密碼」流程 |

理由:

- 自動連結會引入「先佔位」攻擊面(他人用受害者 email 註冊未認證帳號,合法使用者用 Google 登入時被連到攻擊者準備好的 Account)
- 我們本期**不做 email 驗證**,自動連結更不安全
- 「需先登入再 link」的 UX 雖然多一步,但安全性最強且實作最簡單

### 10.6 手動連結 Google(已登入)

#### 流程

```
[client]   POST /auth/google/authorize-init?intent=link
           Authorization: Bearer <access-jwt>
[backend]  驗 access JWT,取 accountId
           產生 sid / state / nonce / code_verifier(同 §4)
           額外存 { accountId, intent: 'link' } 在 OAuth session 中
           回 { sid, authUrl }

[client]   完成 Google flow,取得 code

[client]   POST /auth/google/exchange   (Bearer access-jwt 仍需要)
           body { sid, code, state }
[backend]  驗 access JWT、驗 sid/state、交換 code、驗 ID token(同 §4 / §8)
           比對 session.accountId === jwt.accountId(防 token swap)
           檢查:
             - 該 Google sub 是否已連結至其他 Account → 409 AUTH_GOOGLE_ALREADY_LINKED
             - 當前 Account 是否已有 google credential → 409 AUTH_CREDENTIAL_EXISTS
           建立 GoogleCredential { accountId, externalId: sub, email, linkedAt: now }
           log audit event 'auth_account_linked'
           回 204
```

#### 規則

- **必須是已登入 session**(`Authorization: Bearer <access-jwt>` 必填);未登入呼叫 link 流程 → 401
- 不換發 token(已經在登入狀態,credential 變動不影響當前 session)
- Unlink(解除連結)目前**不提供**;若使用者誤連結需聯絡支援(後續再評估自助 unlink 流程)

### 10.7 與資料模型 spec 的職責邊界

本 §10 描述**形式**(兩層結構 + unique constraint 部位 + 識別流程);**實際**的 column 名、type、index 設計、soft-delete 政策、外鍵 ON DELETE 行為,由資料模型 spec 擁有。本 spec 與 spec 008 引用本節的形式描述。

### 10.8 Interactive-login audit columns(v0.3)

`Account` 上保留兩個 nullable 欄位記錄「最後一次互動式登入」,供 admin / forensic 回溯使用:

| 欄位 | 型別 | 來源 |
|---|---|---|
| `lastLoginAt` | `DateTime?` | 寫入時的 `new Date()`(server clock) |
| `lastLoginType` | enum `LoginType?` (`PASSWORD` / `GOOGLE`) | 觸發 endpoint 對應的 credential type |

#### 觸發規則(寫入 / 不寫入)

| 觸發 | 是否寫入 | 理由 |
|---|---|---|
| `POST /auth/register`(spec 008) | ✅ create 時種子 `PASSWORD` | register 同步發 token,等同首次登入,放在同一個 `account.create()` 省一次 round-trip |
| `POST /auth/login` 成功(spec 008) | ✅ `UPDATE accounts ... type=PASSWORD` 在 `issueBundle` **之前** | 失敗時不留 stale audit(若 issueBundle 失敗,user 重 login 也會修正) |
| `POST /auth/google/exchange` login intent — existing-account | ✅ `UPDATE ... type=GOOGLE` | 同上 |
| `POST /auth/google/exchange` login intent — new-account 分支 | ✅ create 時種子 `GOOGLE`(與 GoogleCredential 同 transaction) | 同 register 邏輯 |
| `POST /auth/google/exchange` link intent(§10.6) | ❌ | caller 已登入(Bearer access-jwt);link 不是新一次登入,不應覆蓋上次 login 紀錄 |
| `POST /auth/password/change` / `/auth/password/set`(spec 008) | ❌ | credential rotation 不是登入事件 |
| `POST /auth/refresh` | ❌ | refresh 是 session 延長,不是 interactive auth |
| `POST /auth/logout` / `/auth/logout-all` | ❌ | 不適用 |
| 失敗的登入(invalid credentials、account locked、collision、email_unverified)| ❌ | audit 反映「成功 interactive 登入」這個語意 |

#### 設計取捨

- **兩欄都 nullable** — pre-v0.3 既有 account 顯示為「never logged in」,比 backfill 假時間誠實
- **用 enum 而非 string** — Prisma client 端型別安全;新 credential type(Apple、GitHub)上線時加 enum value + 兩三行 service code 即可
- **`UPDATE` 而非「順手 select 回來」** — 寫入是 fire-and-forget,對 caller 透明,不擴大 read shape;測試以 `prisma.account.findUnique` 直接驗收
- **重複寫入容忍** — 同一 transaction 中再 UPDATE 一次(理論上不會發生)是 idempotent 的;PG 也不會抱怨

#### 對未來擴充的影響

新增第三種 credential type(例如 Apple Sign-in):
1. `enum LoginType { ... APPLE }` migration
2. Apple service 在「成功 sign-in」與「新建 account」兩處寫入 `lastLoginType=APPLE`
3. Link 仍維持「caller 已登入,不觸發 lastLogin」原則

不需要動其他既有 endpoint。

### 10.9 Account lifecycle 與 disabled 政策(v0.4)

`Account` 帶 3 個 lifecycle 欄位(對齊 Charity / Project / SaleItem 的同 5-set 但去掉 `publishStartAt` / `publishEndAt` — account 沒有上下架時程):

| 欄位 | 用途 |
|---|---|
| `displayOrder Int @default(0)` | 未來 admin 後台 user list 的排序權重;**目前無 endpoint 消費**,純預留 |
| `archivedAt DateTime?` | 管理員「凍結」帳號(可恢復) |
| `deletedAt DateTime?` | 軟刪 |

#### Disabled = archivedAt 或 deletedAt 任一非 null

服務內 helper `isDisabled(account)` 統一判斷;**任一**非 null 即視為 disabled,拒絕互動式 auth。

#### Endpoint 行為

| Endpoint | Disabled account 行為 | 錯誤碼 |
|---|---|---|
| `POST /auth/login`(spec 008) | 仍跑 dummy hash 避免 timing oracle,**之後**返回 disabled 錯誤 | 401 `AUTH_ACCOUNT_DISABLED` |
| `POST /auth/google/exchange` login intent | resolveGoogleLogin 找到既有 account → 檢查 disabled → 401 | 401 `AUTH_ACCOUNT_DISABLED` |
| `POST /auth/google/exchange` login intent **new-account 分支** | 不適用(此 case 在創 account,無既有 disabled 狀態) | n/a |
| `POST /auth/google/exchange` link intent | (caller 已有 JWT;若被 disable 的 caller 嘗試 link → 該 access JWT 短期內仍有效但無實質 link 用途;policy 由 §10.6 守) | n/a |
| `POST /auth/refresh` | consume refresh OK → 查 account → 若 disabled → revoke 所有 refreshes + 401 | 401 `AUTH_ACCOUNT_DISABLED` |
| `POST /auth/password/change` / `password/set` | 透過 JWT 驗證,若 caller 短期內帶 valid access token 仍可呼叫(由 access token TTL 兜底,3h);長期可由未來 admin 主動 logout-all 補強 | n/a |

#### 為什麼是 endpoint-level check 而非 DB filter

考慮過用一個 `whereLive` 樣的 helper 把 archived/deleted filter 進 `findUnique` 的 where。否決理由:

- account lookup 多處(login / refresh / link / password-change)分別需要不同邏輯(login 要跑 dummy hash、refresh 要 revoke);把它包成 filter 反而模糊了「為什麼這次拒絕」
- 明文的 `if (isDisabled(account)) throw disabledError()` 比 silent 404 更利 audit / 客戶端 UX(知道是被 disabled 而非帳密錯)

#### 為什麼不在 archive/delete 時主動 sweep refresh tokens

- 寫入路徑(管理員 archive / delete account)尚未實作 → 沒有自然的 sweep 觸發點
- refresh 路徑的 per-request check 是 catch-net,最壞延遲 = refresh interval(通常 ≤ 3h access TTL)
- 若日後管理員 endpoint 落地,可以順手呼叫 `refreshStore.revokeAll(accountId)`,但**不**先做(spec 019 §6 / ADR 011 同樣的「不為假設場景設計」原則)

#### Active access token 在 archive 後的視窗

archive 之後,舊 access JWT 在剩餘 TTL 內(最多 3h,ADR 004)仍能呼叫 `/password/change` 等帶 JWT 驗證的 endpoint。這是 ADR 004「短 access TTL」設計的明示 trade-off:

- 不做 JWT blacklist(會把 stateful 帶回 access path,違反 spec 007 §11)
- 接受 ≤ 3h 的「殭屍 session」視窗

要更嚴格的話,access TTL 縮短或引入 stateful access store(本期不做)。

### 10.10 Account.role 與後台授權(v0.5)

`Account` 帶 `role Int @default(1)` 一欄。固定 const(`src/lib/auth/role.ts`):

```ts
export const Role = {
  ADMIN: 0,
  USER: 1,
} as const

export type RoleValue = (typeof Role)[keyof typeof Role]
```

#### 為什麼 const literal 而非 Prisma enum

| 比較 | 結論 |
|---|---|
| Prisma enum | 改值需 schema migration;對 demo 階段過重 |
| TS const(採用) | 改 enum mapping = 一行 code change;DB 只存 Int |

未來如需 `MODERATOR` / `SUPPORT` 等更細分,再升 Prisma enum(v0.5 收束 spec 008 §14 OQ「admin role 怎麼放」)。

#### 為什麼 0 = ADMIN

- JavaScript 中 `undefined === 0` 為 false → **舊 JWT(無 role claim)被讀為 `undefined`,自動非 admin**,fail-safe
- 命名與 HTTP 0 = "no error" 概念對齊(「最高權限 = 最低值」)

#### Account.role 寫入時機

| 觸發 | 寫入規則 |
|---|---|
| `POST /auth/register`(spec 008) | 預設 `role = USER`(=1) |
| `POST /auth/google/exchange` login intent — new-account 分支 | 預設 `role = USER` |
| Bootstrap 第一筆 admin | 透過 prisma seed 寫死 / 一次性 script(本期落地;spec 020 §14 OQ #10) |
| Admin 端點「升降權」 | 本期 **不**提供 — 改 role 需走 DB 直連或未來 admin API |

#### JWT 中的 role claim

- access JWT(本 spec §11.1)新增 `role` claim,值為 `Account.role`
- refresh 路徑 issueBundle 時**重新從 DB 讀取** role,避免「admin 中途被降級但 access 在 TTL 內仍有效」的視窗(對齊 §10.9 zombie-session 處理)

#### 後台授權的範圍

`role === ADMIN` 是進入「後台寫入端點」(spec 020 §3 的 23 個端點 + spec 018 presign,v0.5)的必要條件。其他端點:

| 端點群 | role 檢查? |
|---|---|
| Public read(`/v1/donation/*` GET) | ❌ 不檢查;任何 caller 可讀 |
| Self-service(`/auth/me/*`)| ❌ 不檢查 role;只檢查「JWT 有效 + account 非 disabled」(§10.9) |
| 認證類(`/auth/login` / refresh / logout)| ❌ 不檢查 role |
| `requireAdmin` preHandler(`src/lib/auth/bearer.ts` v0.5 新增) | ✅ `role !== ADMIN` → 403 `FORBIDDEN` |

---

## 11. Token 發放(落實 ADR 004)

### 11.1 Access Token

```jsonc
{
  "iss": "<api-host>",            // 本服務 host
  "aud": "<api-audience>",        // 預設與 iss 相同
  "sub": "<userId>",              // 我們自己的 userId(非 Google sub)
  "jti": "<uuid>",                // 用於 blacklist
  "type": "access",
  "role": 0 | 1,                  // v0.5 — §10.10:0=ADMIN, 1=USER;從 Account.role 讀
  "iat": <now>,
  "exp": <now + 10800>            // 3h(ADR 004)
}
```

- 演算法:**HS256**(與 `JWT_ACCESS_SECRET` 對稱簽)— 同一服務內驗證,不需 asymmetric
- 若未來提供 third-party verify,改 RS256 + 公鑰公開
- **`role` claim 預設給,缺值視為 USER**(`requireAdmin` 用 `claims.role === 0` 嚴格比對,`undefined === 0` 為 false → fail-safe)
- refresh path 重新從 DB 讀 role,寫入新 access token(§10.10 一致性說明)

### 11.2 Refresh Token

```jsonc
{
  "iss": "<api-host>",
  "sub": "<userId>",
  "jti": "<tokenId>",             // = Redis key 後綴
  "type": "refresh",
  "iat": <now>,
  "exp": <now + 2592000>          // 30d(ADR 004)
}
```

- 演算法:HS256 with `JWT_REFRESH_SECRET`(與 access 不同密鑰,降低洩漏風險擴散)

### 11.3 Redis 存放

呼應 spec 006 §15.1 與 ADR 004 §「Redis Key 設計」:

```
jkod:auth:refresh:{tokenId}        Hash {
                                     userId,
                                     hashedToken,     // sha256(refreshJwt) hex
                                     createdAt,
                                     used             // 'false' / 'true'
                                   }
                                   TTL = refresh 壽命 + 60s grace

jkod:auth:refresh:user:{userId}    SET of tokenId
                                   TTL = max(各 token 剩餘壽命) — 用 SADD 後 EXPIRE

jkod:auth:blacklist:{jti}          STRING "1"
                                   TTL = access 剩餘壽命
```

- 儲存 `hashedToken`(SHA-256),而非原始 JWT;refresh 比對時先 hash 再對比
- `used` 旗標支援 replay detection(§5.1):被消費後標 true,grace 期內若再見即觸發 revoke-all
- grace 期 60s:容許網路重試造成的合法重送(client retry 同一個 refresh)

### 11.4 簽發規則

- token 簽發**集中於 `src/lib/auth/tokens.ts`**:`issueTokens(userId): { access, refresh }`
- 業務 / route 不直接 `import jsonwebtoken` 或操作 Redis token key

---

## 12. 錯誤情境

| 情境 | HTTP | code | 對外訊息 |
|---|---|---|---|
| `sid` 不存在 / 已過期 | 401 | `AUTH_OAUTH_SESSION_INVALID` | "OAuth session expired or invalid" |
| `state` 不符 | 401 | `AUTH_STATE_MISMATCH` | "Invalid state parameter" |
| Google `/token` 4xx | 401 | `AUTH_OAUTH_EXCHANGE_FAILED` | "OAuth exchange failed" |
| Google `/token` 5xx / timeout | 502 / 504 | `UPSTREAM_FAILURE` / `UPSTREAM_TIMEOUT` | "Identity provider unavailable" |
| ID Token 簽章 / iss / aud / exp / nonce 失敗 | 401 | `AUTH_ID_TOKEN_INVALID` | "Identity token invalid" |
| `email_verified !== true` | 401 | `AUTH_EMAIL_UNVERIFIED` | "Email is not verified" |
| Login intent:Google email 已被其他 Account 佔用(無對應 GoogleCredential) | 409 | `AUTH_EMAIL_OWNED_BY_OTHER_ACCOUNT` | "Email belongs to another account. Sign in with that account first, then link Google in settings." |
| Link intent:Google sub 已被連結到其他 Account | 409 | `AUTH_GOOGLE_ALREADY_LINKED` | "This Google account is already linked elsewhere" |
| Link intent:當前 Account 已有 Google credential | 409 | `AUTH_CREDENTIAL_EXISTS` | "Google is already linked to this account" |
| Link intent:JWT accountId 與 session.accountId 不符 | 401 | `AUTH_LINK_SESSION_MISMATCH` | "Link session mismatch" |
| Refresh token 簽章 / 過期 | 401 | `AUTH_TOKEN_EXPIRED` / `UNAUTHORIZED` | "Token expired" / "Unauthorized" |
| Refresh token 已撤銷 | 401 | `AUTH_REFRESH_REVOKED` | "Refresh token revoked" |
| Refresh token replay | 401 | `AUTH_REFRESH_REPLAY` | "Refresh token reuse detected; please sign in again" |
| Redis 不可用(`auth` tier) | 503 | `SERVICE_UNAVAILABLE` | "Authentication service temporarily unavailable" |

詳細格式遵守 spec 005 §6 RFC 7807。

### 12.1 訊息揭露原則

- 4xx 對外揭露 `code`,可揭露通用 message;**不**揭露「Redis 找不到 sid 還是 state 不符」這類細節,避免做 oracle
- 5xx 對外不揭露細節(spec 005 §11.1)
- timing-safe 比對在 §9.3 已要求

---

## 13. 安全

### 13.1 Transport

- 所有端點僅接受 HTTPS(prod / stage);dev 可 HTTP(localhost)
- HSTS 由 BFF / 反向代理層處理

### 13.2 Token 在傳輸與儲存中的曝險

- backend ↔ BFF:HTTPS + Bearer header(不放 query string、log 必須 redact,spec 004 §7.1 已涵蓋)
- BFF ↔ Browser:httpOnly + secure + sameSite=lax cookie(BFF 責任)
- Redis 中存 hashed refresh,不存原 JWT

### 13.3 PKCE 與 state / nonce

- **PKCE 必開**(§3.2)
- state / nonce 都是 32+ bytes random,timing-safe 比對
- OAuth session(`sid`)**單次使用**,exchange 成功立即 DEL

### 13.4 Google OAuth Client 隔離

- dev / stage / prod **各自獨立** Google OAuth client(spec 001 §3.5)
- prod client 的 `client_secret` 屬高敏感,只由 secret manager 注入

### 13.5 Email Verified 必驗

- `email_verified=false` 一律拒絕,防範未驗證 email 帳號被接管(攻擊者註冊一個未驗證 Google 帳號,先一步用受害者 email 來「先佔位」)
- Google 對自家帳號 `email_verified` 一律 true,但 OIDC 規範允許 false,**不**信任前提

### 13.6 Replay Detection 處置

- 偵測到 refresh replay,**撤銷該 user 所有 refresh 而非單一 token**
- 同時 audit log(`audit:true, event:'auth_refresh_replay'`),便於後續分析

### 13.7 Brute Force / Rate Limit

- `POST /auth/refresh` 與 `POST /auth/google/exchange` 走 rate-limit tier(spec 006 §5)
- 預設:同 IP 每分鐘 30 次;同 sid 1 次(exchange 成功 sid 即失效)
- 細節由 rate-limit 模組 spec 定義

### 13.8 Open Redirect 防護

- `returnTo` 必須是**相對路徑**或在白名單網域內;否則 ignore 或拒絕
- 拒絕 `//evil.example.com` 這類協議相對 URL

---

## 14. 環境變數需求

### 14.1 既有(spec 001)

- `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_CALLBACK_URL`(註冊在 Google Console 的 redirect URI,**指向 BFF**)
- `REDIS_URL`(`auth` tier)
- 既有 `JWT_SECRET` / `JWT_EXPIRES_IN`(待 ADR 004 落地時拆)

### 14.2 新增(本 spec 提出,待併入 spec 001 §3.4 與 spec 002)

| Key | 必填 | dev 預設 | 說明 |
|---|---|---|---|
| `JWT_ACCESS_SECRET` | ✅ | 隨機 32+ 字元 | access token 簽章密鑰 |
| `JWT_ACCESS_EXPIRES_IN` | | `3h` | access token 壽命(ADR 004) |
| `JWT_REFRESH_SECRET` | ✅ | 隨機 32+ 字元(與 access 不同) | refresh token 簽章密鑰 |
| `JWT_REFRESH_EXPIRES_IN` | | `30d` | refresh token 壽命 |
| `JWT_ISSUER` | ✅ | `http://localhost:3001` | JWT `iss` claim |
| `JWT_AUDIENCE` | | 同 `JWT_ISSUER` | JWT `aud` claim;預設與 iss 相同 |
| `OIDC_DISCOVERY_URL` | | `https://accounts.google.com/.well-known/openid-configuration` | OIDC discovery 端點(預設值幾乎不需改) |

> spec 001 與 spec 002 需依此提 v0.3。

---

## 15. 觀測性

### 15.1 Event 字典(本 spec 擁有,擴充 spec 004 §9.3)

| event | 觸發點 | level | audit |
|---|---|---|---|
| `auth_authorize_init` | `/authorize-init` 成功 | info | — |
| `auth_exchange_success` | `/exchange` 登入完成、token 簽發 | info | ✅ |
| `auth_account_created` | 任一來源建立新 Account(Google 首登 / 帳密註冊) | info | ✅ |
| `auth_account_linked` | 已登入者新增 credential(本 spec 為 Google) | info | ✅ |
| `auth_email_owned_by_other_account` | Google sign-in 時 email 已被佔用,擋 409 | warn | ✅ |
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
| `auth_email_unverified` | Google 回傳 email_verified=false | warn | — |
| `auth_upstream_failure` | Google `/token` 5xx | error | — |

> 帳密相關 event(`auth_login_password_*` / `auth_register_password` 等)由 spec 008 擁有。

### 15.2 規則

- log 中**禁出現** `code` / `state` / `nonce` / `codeVerifier` / `id_token` / `refreshToken` / `accessToken` 原始值
- 出現 `userId` / `sub` 是允許的(spec 004 §4.3 規範)

---

## 16. 測試策略

呼應 backend `CLAUDE.md`:不 mock Redis / Prisma;Google `/token` 與 JWKS 屬外部 HTTP,用 `msw` 或 fetch stub。

### 16.1 Unit

- ID token 驗證:用測試金鑰簽 fake ID token,放入測試用 JWKS;驗證簽章 / iss / aud / nonce 各失敗分支
- state / nonce 比對:timing-safe、長度檢查
- token 簽發 / 驗證:`tokens.ts` 的 `issueTokens` / `verifyAccess` / `verifyRefresh`
- replay detection:模擬 Redis `used:true` 狀態,驗證觸發 revoke-all

### 16.2 Integration

- `POST /auth/google/authorize-init` → 回 `{ sid, authUrl }`,Redis 該 key 存在且 TTL 約 600s
- `POST /auth/google/exchange` → mock Google `/token` 與 JWKS,驗證:
  - 成功 happy path:回 token、Redis sid DEL、refresh 存在、user account upsert
  - state 不符 / sid 不存在 / id token nonce 不符 / email_verified=false → 對應 code
  - Google 5xx / timeout → 502 / 504
- `/refresh` → happy path + replay 路徑
- `/logout` / `/logout-all` → token 與 SET 正確清除

### 16.3 不測試

- 真實 Google login UI 與 redirect(屬 BFF / e2e 範疇)
- 真實 Google OAuth 流量(不可重現、不可在 CI 跑)

---

## 17. 開放問題

- **JWT `kid` 與多 secret rotation**:目前 access / refresh 各一把 secret;若日後做 secret rotation,需在 JWT 加 `kid` 並維護新舊 secret window。先記,不做
- **`access_type=offline` 取 Google refresh token**:目前不需要(§3.4);若日後要做「以使用者身分呼叫 Google API」再評估
- **Unlink Google credential**:目前手動連結後不提供自助 unlink;誤連結需聯絡支援。若 UX 反饋強烈,再加 `DELETE /auth/google/link`(要求重新驗證密碼或 OIDC 確認後才放行,避免帳號丟失)
- **行動 App / SPA 直連 backend**(無 BFF):本 spec 假設一定有 BFF。若行動端要直連,PKCE 流程一致,但 client_secret 變成 public client,需另外規劃
- **Logout 同步登出 Google**(OIDC RP-initiated logout):本 spec 不做(§6.3);若 UX 反饋需要,再評估
- **JWT 改 RS256 並對外揭露 JWKS**:本 spec 用 HS256(內部驗證即可);若日後 BFF / 行動端要自驗 token,改 RS256 並提供 `/.well-known/jwks.json`
- **Email 驗證**:本期不做;若引入,需新增寄信模組、驗證 token store(Redis `auth` tier 已預留)、Account.emailVerified 旗標、未驗證帳號的存取限制策略

---

## 18. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-13 | 初版 |
| 0.2 | 2026-06-13 | 引入 Account ↔ Credential identity 模型(§10),供 spec 008(帳密)共用;Google sign-in 邏輯改為查 GoogleCredential,email 衝突走嚴格手動連結(無自動連結);新增 §10.5 連結政策、§10.6 手動連結 Google 流程(`intent=link`);§7 端點規格擴充 intent 區分;§12 新增 4 個錯誤碼(`AUTH_EMAIL_OWNED_BY_OTHER_ACCOUNT` / `AUTH_GOOGLE_ALREADY_LINKED` / `AUTH_CREDENTIAL_EXISTS` / `AUTH_LINK_SESSION_MISMATCH`);§15 新增 6 個 event;§17 更新開放問題(account linking 變成 unlink、email 驗證留作未來);移除「帳密不支援」「account linking 不支援」字眼(已分別由 spec 008 與 §10.6 涵蓋) |
| 0.3 | 2026-06-15 | §10 加 §10.8 `Account.lastLoginAt` / `lastLoginType` 兩個 audit 欄位(nullable + `LoginType` enum `PASSWORD` / `GOOGLE`);明文寫入 / 不寫入規則 — register / login 成功 / Google exchange login intent 兩條路徑寫入,link intent / change-password / set-password / refresh / logout / 失敗登入皆不寫入。新增 Prisma migration `add_account_last_login` + service 層 `account.update / create` 對應 2 處(`auth/service.ts` register + login,`auth-google/service.ts` existing-account login + new-account 分支)。spec 008 §5.4 同步引用 |
| 0.4 | 2026-06-15 | §10.1 改寫:`username` 為新主鍵,`email` 變 optional(兩者皆 nullable + unique,應用層強制「至少一個」);§10.2 帳密 sign-in 改用單一 `identifier` 欄位 + `@` sniff;新增 §10.9 Account lifecycle policy(`displayOrder` / `archivedAt` / `deletedAt`,任一 lifecycle stamp 非 null 即 disabled,login / refresh / Google exchange 全 401 `AUTH_ACCOUNT_DISABLED`,refresh 觸發 `revokeAll`);3 個新 error code(`AUTH_USERNAME_TAKEN` / `AUTH_IDENTIFIER_REQUIRED` / `AUTH_ACCOUNT_DISABLED`);Prisma migration `account_username_and_lifecycle`。spec 008 §3.4 / §4 / §5 同步引用 |
| 0.5 | 2026-06-15 | §10.1 Account ER box 加 `role`(Int @default(1));新增 §10.10「Account.role 與後台授權」 — 引入 `src/lib/auth/role.ts` const(`ADMIN=0` / `USER=1`)、寫入時機、`requireAdmin` preHandler 規約;§11.1 access JWT claims 加 `role`,refresh path 重新從 DB 讀(避免「中途降權但 access TTL 內仍有效」);後台 = spec 020 §3 的 23 個寫入端點 + spec 018 presign。spec 008 §4.2 同步寫 register 預設 `role=1`;spec 020 §2.3 / §11 / §14 OQ #1 收束 |
