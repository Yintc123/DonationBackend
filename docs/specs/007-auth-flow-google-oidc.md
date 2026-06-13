# Spec 007:Auth Flow(Google OAuth 2.0 + OIDC)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.1 |
| 日期 | 2026-06-13 |
| 適用範圍 | `backend/src/routes/auth/*`、`backend/src/lib/auth/*` |
| 相關 ADR | `docs/decisions/002-backend-framework.md`(BFF 邊界)、`docs/decisions/004-auth-token-strategy.md`(access + refresh) |
| 相關 spec | `001-environment-config.md`、`004-logger-module.md`、`005-error-handling.md`、`006-redis-module.md`(`auth` tier) |

---

## 1. 目的與範圍

### 1.1 目的

定義 backend 的使用者驗證流程,涵蓋:

- 使用 **Google OAuth 2.0 + OIDC** 取得使用者身分
- **Authorization Code with PKCE** 防範授權碼攔截
- **state / nonce** 防範 CSRF 與 replay
- 驗證 Google **ID Token** 並對應至本服務的 user account
- 落實 ADR 004 的雙 token 策略(access 3h + refresh 30d)、rotation、replay detection
- 登出與全裝置登出

### 1.2 In scope

- Google as the only IdP(OIDC discovery、JWKS、ID Token 驗證)
- Backend 對外端點(BFF → backend 的 JSON API)
- OAuth session 短暫狀態管理(Redis `auth` tier)
- Token 發放、refresh、撤銷
- 與 BFF 的責任切分

### 1.3 Out of scope(後續或不做)

- 其他 provider(Facebook、Apple、GitHub) — 目前無需求
- 帳號 / 密碼登入 — 不支援
- 多因素(MFA / TOTP) — 後續評估
- 帳號合併 / 變更 IdP — 後續評估
- BFF 內部 session cookie 細節 — 由前端 spec 處理
- 細粒度權限 / RBAC — 後續業務 spec
- Account linking(同 email 不同 provider 合併) — 不支援(暫鎖一個 provider per user)

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
8. Upsert user account(§10)
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
| 認證 | 不需要 |
| Body | `{ "returnTo"?: string }` |
| 200 Response | `{ "sid": "<uuid>", "authUrl": "<google url>" }` |
| Errors | 500 (`INTERNAL_ERROR`) |

### 7.2 `POST /auth/google/exchange`

| 項目 | 內容 |
|---|---|
| 認證 | 不需要 |
| Body | `{ "sid": "<uuid>", "code": "<string>", "state": "<string>" }` |
| 200 Response | `{ accessToken, accessExpiresIn, refreshToken, refreshExpiresIn, tokenType: "Bearer", returnTo? }` |
| Errors | 401 (`AUTH_OAUTH_SESSION_INVALID`、`AUTH_STATE_MISMATCH`、`AUTH_ID_TOKEN_INVALID`)、400 (`VALIDATION_FAILED`)、502 (`UPSTREAM_FAILURE`)、504 (`UPSTREAM_TIMEOUT`) |

### 7.3 `POST /auth/refresh`

| 項目 | 內容 |
|---|---|
| 認證 | `Authorization: Bearer <refresh-jwt>` |
| Body | (空) |
| 200 Response | 同 §7.2 |
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

## 10. User 對應與首次註冊

### 10.1 識別欄位

- 主鍵:`(provider, externalId)` 唯一,本期 `provider='google'`、`externalId=<google sub>`
- 次要:`email`(Google 已驗證,但**不**作為主鍵,避免使用者改 email 後失聯)
- 其他 profile 欄位(`name`、`picture`)依資料模型 spec 決定是否儲存

### 10.2 流程

```
look up by (provider='google', externalId=sub)
  found     → return user
  not found → create user with { provider, externalId, email, ... }
              log audit event auth_user_created
              return user
```

### 10.3 規則

- **首次登入即等同註冊**,不分流程(無「先註冊再登入」步驟)
- email 衝突處理:若新使用者的 email 已被其他 `(provider, externalId)` 佔用 → 拒絕,回 409 (`AUTH_EMAIL_TAKEN`),提示使用者已用其他帳號登入
  - 此規則防範同 email 多 provider 帳號;若日後支援 account linking,改規則
- **不在本 spec 內**定義 user table 細節,由資料模型 spec 處理

### 10.4 並發控制

- 兩個 request 同時為同一 Google `sub` 註冊 → 用 DB unique constraint 防止重複,失敗側 retry 走 found 分支
- 不在 Redis lock,因為 DB unique 已足夠

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
  "iat": <now>,
  "exp": <now + 10800>            // 3h(ADR 004)
}
```

- 演算法:**HS256**(與 `JWT_ACCESS_SECRET` 對稱簽)— 同一服務內驗證,不需 asymmetric
- 若未來提供 third-party verify,改 RS256 + 公鑰公開

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
| email 已被佔用(其他 user) | 409 | `AUTH_EMAIL_TAKEN` | "Email already in use by another account" |
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
| `auth_exchange_success` | `/exchange` 完成、token 簽發 | info | ✅ |
| `auth_user_created` | 首次登入新建 user account | info | ✅ |
| `auth_refresh_success` | refresh rotation 完成 | info | — |
| `auth_refresh_replay` | 偵測到 refresh replay | warn | ✅ |
| `auth_logout` | 單 session 登出 | info | ✅ |
| `auth_logout_all` | 全裝置登出 | info | ✅ |
| `auth_oauth_session_invalid` | sid 不存在 / 過期 | warn | — |
| `auth_state_mismatch` | state 不符 | warn | — |
| `auth_id_token_invalid` | ID token 驗證失敗 | warn | — |
| `auth_email_unverified` | Google 回傳 email_verified=false | warn | — |
| `auth_upstream_failure` | Google `/token` 5xx | error | — |

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

- **JWT `kid` 與多 secret rotation**:目前 access / refresh 各一把 secret;若日後做 secret rotation,需在 JWT 加 `kid` 並維護新舊 secret window。先記，不做
- **`access_type=offline` 取 Google refresh token**:目前不需要(§3.4);若日後要做「以使用者身分呼叫 Google API」再評估
- **Account linking**(同 email 不同 provider 合併):目前直接 409;若日後支援其他 provider,需設計合併流程
- **行動 App / SPA 直連 backend**(無 BFF):本 spec 假設一定有 BFF。若行動端要直連,PKCE 流程一致,但 client_secret 變成 public client,需另外規劃
- **Logout 同步登出 Google**(OIDC RP-initiated logout):本 spec 不做(§6.3);若 UX 反饋需要,再評估
- **JWT 改 RS256 並對外揭露 JWKS**:本 spec 用 HS256(內部驗證即可);若日後 BFF / 行動端要自驗 token,改 RS256 並提供 `/.well-known/jwks.json`

---

## 18. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-13 | 初版 |
