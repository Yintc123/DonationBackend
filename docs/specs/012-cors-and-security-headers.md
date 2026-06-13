# Spec 012:CORS 與 Security Headers

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.1 |
| 日期 | 2026-06-13 |
| 適用範圍 | `backend/src/plugins/cors.ts`、`backend/src/plugins/helmet.ts`、`backend/src/plugins/trust-proxy.ts` |
| 相關 ADR | `docs/decisions/002-backend-framework.md` |
| 相關 spec | `001-environment-config.md`(`CORS_ORIGIN`)、`009-api-response-and-http-status.md`(`X-Request-Id` / `X-RateLimit-*` 必須被 exposed)、`010-rate-limit-module.md`(§15.1 trustProxy)、`011-health-check.md`(§8 health 端點豁免) |

---

## 1. 目的與範圍

### 1.1 目的

定義 backend 服務的瀏覽器層安全規約:

- **CORS**:控制哪些 origin 可以呼叫 backend
- **Security Headers**:layer-of-defense,即使前端 / BFF 有漏洞也能限制傷害
- **Trusted Proxy**:正確解析 `X-Forwarded-*`,讓 rate-limit / 日誌不被偽造
- **HSTS 強制 HTTPS**:在 client 端永久綁定

### 1.2 In scope

- `@fastify/cors` 設定
- `@fastify/helmet` 設定 + 自訂 CSP
- Fastify `trustProxy` 設定
- HSTS、Referrer-Policy、CSP、COOP / COEP / CORP 等 header 規約
- 與 BFF 間 cookie / credential 約定

### 1.3 Out of scope

- **TLS 證書 / 終結點 設定**:由部署 / 反向代理層處理
- **WAF / IDS**:基礎設施層
- **HSTS preload 註冊**:domain 上線後再評估
- **Bot 偵測 / 人機驗證**:後續(CAPTCHA / Turnstile)
- **HTML 頁面 CSP**:本服務不出 HTML(API 為主)
- **Cookie 簽發 / session 管理**:由 BFF 負責(spec 007 §2)

---

## 2. Threat 模型

| 威脅 | 來源 | 本 spec 防護 |
|---|---|---|
| **CSRF**(瀏覽器在 user session 下對 backend 發起跨站請求) | 任意惡意網站 | CORS allowlist + cookie 設計(預設不發 cookie)+ BFF SameSite |
| **跨站讀取**(攻擊網站讀 backend 回應) | 惡意 JS | CORS allowlist + `Cross-Origin-Resource-Policy: same-site` |
| **點擊劫持 / iframe 嵌入** | 任意 iframe | `X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'` |
| **降級為 HTTP**(SSL strip) | 中間人 / WiFi 劫持 | HSTS + 部署層強制 HTTPS |
| **真實 IP 偽造**(影響 rate-limit / log) | 攻擊者偽造 `X-Forwarded-For` | `trustProxy` 設定 + 不可由 client 設定 `X-Request-Id` 信任值 |
| **MIME sniffing 攻擊** | 上傳 / 內容混淆 | `X-Content-Type-Options: nosniff` |
| **Referrer 洩漏** | 跨站連結 | `Referrer-Policy: no-referrer` |
| **Browser 指紋 / 第三方權限濫用** | 第三方 script | `Permissions-Policy` 全關 |

### 2.1 不在防線

- 應用層 SQL injection / IDOR — 由 input validation + ORM(spec 003)處理
- 認證 / 授權 — spec 007 / 008
- Rate-limit — spec 010

---

## 3. CORS 規約

### 3.1 設定值

| 項目 | 值 | 說明 |
|---|---|---|
| `origin` | 由 `CORS_ORIGIN` 環境變數提供,逗號分隔多筆;**禁用** `*` 通配 | spec 001 §3.6 |
| `credentials` | `true` | BFF 經 fetch 帶 cookie / Authorization 時必須 |
| `methods` | `GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD` | 不含 `TRACE` / `CONNECT` |
| `allowedHeaders` | `Content-Type, Authorization, Idempotency-Key, X-Request-Id` | 各 header 來源見 spec 005/007/009 |
| `exposedHeaders` | `X-Request-Id, Location, ETag, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-RateLimit-Layer` | 對齊 spec 009/010 |
| `maxAge` | `600`(10 分鐘) | preflight 快取 |
| `optionsSuccessStatus` | `204` | 明確 204 |

### 3.2 為什麼禁 `*`

- `Access-Control-Allow-Origin: *` 與 `Access-Control-Allow-Credentials: true` **不能共存**(W3C 規範)
- 本服務一律帶 credentials → `*` 不可用
- 即使可用,wildcard 在 prod 等於放棄 CORS 保護,**不允許**

### 3.3 多 origin 設定

`CORS_ORIGIN` 接受逗號分隔多筆:

```bash
CORS_ORIGIN="https://app.example.com,https://staff.example.com"
```

- backend 啟動時 parse 為 `Set<string>`
- request 帶 `Origin` header 時,精確比對(不做 wildcard / regex)
- 不在清單內 → 不發 `Access-Control-Allow-Origin`,瀏覽器自動阻擋

### 3.4 dev 寬鬆設定

- dev `CORS_ORIGIN` 預設 `http://localhost:3000`(BFF Next.js dev server)
- 不允許 dev 也用 `*`(寧可手動加 origin,養成正確習慣)

### 3.5 規則

- 新加 origin 必須:
  - 由人工 review(PR description 說明為何加)
  - 寫進部署平台環境變數,非寫死於程式碼
- 任何 origin 必為 HTTPS(prod / stage);**dev 允許 HTTP localhost**
- 不接受 `null` origin(file://、data:、sandbox iframe);如果遇到 → 不發 `Access-Control-Allow-Origin`

### 3.6 OPTIONS 行為

- `@fastify/cors` 接管 preflight,自動回 204 + 必要 headers
- preflight **不**套用 rate-limit(避免高頻 OPTIONS 撐爆計數)— spec 010 §3.2 補追
- preflight 不寫 request log(spec 004 §6.1 已排除 health,本 spec 補追 OPTIONS)

---

## 4. Security Headers 清單

採 `@fastify/helmet` 提供大部分,自訂少數覆寫。

### 4.1 必設清單

| Header | 值 | 設定者 |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | helmet(預設 180d,本 spec 升 365d) |
| `X-Content-Type-Options` | `nosniff` | helmet 預設 |
| `X-Frame-Options` | `DENY` | helmet 預設 `SAMEORIGIN`,本 spec 升 `DENY` |
| `Referrer-Policy` | `no-referrer` | helmet 預設 |
| `Permissions-Policy` | `accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()` | 自訂 |
| `Cross-Origin-Opener-Policy` | `same-origin` | helmet 預設 |
| `Cross-Origin-Embedder-Policy` | `require-corp` | helmet 預設 |
| `Cross-Origin-Resource-Policy` | `same-site` | 自訂(預設 `same-origin` 對跨子域 BFF 太緊) |
| `X-DNS-Prefetch-Control` | `off` | helmet 預設 |
| `X-Download-Options` | `noopen` | helmet 預設(IE 遺產,留著無害) |
| `X-Permitted-Cross-Domain-Policies` | `none` | helmet 預設 |

### 4.2 必移除

| Header | 原因 |
|---|---|
| `X-Powered-By: Express`(或任何 stack) | 洩漏 stack 指紋 |
| `Server: <fastify/version>` | 同上;反向代理層也應覆寫 |

helmet 自動處理 `X-Powered-By`;`Server` 視部署而定。

### 4.3 已過時但 helmet 仍設

| Header | helmet 行為 | 我們的態度 |
|---|---|---|
| `X-XSS-Protection: 0` | 設 0(disable browser XSS auditor,因該機制本身有 bug) | 保留 helmet 預設 |

---

## 5. Content Security Policy(CSP)

### 5.1 設定

```
Content-Security-Policy:
  default-src 'none';
  frame-ancestors 'none';
  base-uri 'none';
  form-action 'none'
```

### 5.2 理由

- 本服務只回 JSON,**不**回 HTML / 不執行 script
- `default-src 'none'` = 任何 script / img / style / 連線一律封鎖(沒人會在 API 回應中用,但若某天意外回 HTML,CSP 是最後防線)
- `frame-ancestors 'none'` = 任何 iframe 嵌入都被擋(與 `X-Frame-Options: DENY` 等效,雙保險)
- `base-uri 'none'` / `form-action 'none'` = 即使誤回 HTML 也擋

### 5.3 例外

- 若日後引入 OpenAPI Swagger UI(`@fastify/swagger-ui`),需放寬:該路徑單獨設 `script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:` 等
- 由 swagger plugin 自行 override CSP,不影響其他端點
- 本期未啟用 swagger UI,以上規約**不**設例外

---

## 6. Trusted Proxy

### 6.1 設定

Fastify 啟動時:

```ts
const app = Fastify({
  trustProxy: parseTrustedProxies(process.env.RATE_LIMIT_TRUSTED_PROXIES),
  // ...其他
})
```

- 接受 CIDR 清單(例 `10.0.0.0/8,192.168.0.0/16`)
- dev 預設**空字串**:不信任任何 proxy(直接讀 `socket.remoteAddress`)
- prod / stage **必設**具體 CIDR;若空 → 啟動失敗(`@fastify/env` schema 在 prod 模式下強制非空)

### 6.2 為什麼不能 `trustProxy: true`

`true` 表示信任**任何**前端 proxy,包含攻擊者自架的中繼。攻擊者可:

```
GET /v1/<resource>
X-Forwarded-For: 127.0.0.1
```

→ backend 將攻擊者視為 loopback → 繞過 rate-limit、繞過 IP 白名單。

正確做法:**只信任 BFF / load balancer 的具體 IP / CIDR**。

### 6.3 影響的欄位

啟用 `trustProxy` 後,以下值由 `X-Forwarded-*` 衍生:

| 欄位 | 來源 |
|---|---|
| `request.ip` | `X-Forwarded-For` 第一個非受信任 IP |
| `request.protocol` | `X-Forwarded-Proto`(`http` / `https`) |
| `request.hostname` | `X-Forwarded-Host` |

未啟用時改讀 socket。

### 6.4 與 rate-limit 的協作

- spec 010 §15.1 已要求必設 `trustProxy`,本 spec 提供唯一實作位置(`src/plugins/trust-proxy.ts`)
- 若部署環境改變,**只在環境變數調整**,不改程式碼

### 6.5 `X-Request-Id` 信任邊界

- spec 004 §6.3 接受 client 帶入的 `X-Request-Id`(BFF 可傳給 backend 做關聯)
- **但**:client 帶入值若格式不符(非 UUID v4)或長度異常,**捨棄**並重新產生
- 防止 client 用「特定 reqId」作為標記繞過某些 log/metric 規約

---

## 7. HTTPS 規約

### 7.1 終結點

- TLS 終結於**部署層 reverse proxy / LB**(BFF、Cloudflare、AWS ALB 等),不在 backend
- backend 內部走 HTTP(已在受信任網段內)
- backend **不**自行做 HTTP → HTTPS redirect(會干擾內部健康檢查)

### 7.2 HSTS

- backend 仍設 `Strict-Transport-Security`(§4.1),即使自己跑 HTTP——browser 看到的是經過 proxy 重寫後的 https response,而 backend 設此 header 等於「最終由 proxy 透傳給 client」
- max-age **365 天**(`31536000`),`includeSubDomains`,**暫不**加 `preload`(留待 domain 上線)
- dev 仍設(無 client 會用 dev domain 處理 HSTS,影響可忽略)

### 7.3 強制 HTTPS

- 由 reverse proxy 處理 HTTP redirect → HTTPS
- backend 信任 `X-Forwarded-Proto`(經 trustProxy 後可用);若收到 `http` 時也不主動拒絕(內部 health 等可走 HTTP)

---

## 8. Cookie 規約

### 8.1 backend 不發 cookie(預設)

- spec 007 §2 明示:backend 是 stateless JSON API,session cookie 由 BFF 持有
- backend response 預設**不**含 `Set-Cookie`

### 8.2 例外與規則

若日後某些端點必須發 cookie(目前無情境,留作預防):

| 屬性 | 強制 |
|---|---|
| `Secure` | 必設 |
| `HttpOnly` | 必設 |
| `SameSite` | `Strict` 或 `Lax`(視場景);**禁** `None` 除非 cross-site 必要且接受降級風險 |
| `Path` | 限制最小範圍 |
| `Max-Age` / `Expires` | 必設;`Session` cookie 僅在絕對必要時 |
| `Domain` | 不設(預設 host-only,最安全) |

### 8.3 任何 cookie 名稱前綴

- 使用 `__Host-` 前綴(瀏覽器強制要 Secure + Path=/ + 無 Domain),提高防護
- 或 `__Secure-` 前綴(強制 Secure)

---

## 9. 與其他模組整合

### 9.1 與 Logger(spec 004)

- 不在 log 中印出 `Authorization` / `Cookie` / `X-Api-Key`(spec 004 §7.1 redact 已涵蓋)
- 加入 redact 路徑:`req.headers["x-forwarded-for"]`,**不**完全 redact(rate-limit / 風控需要 ip)但 prod 視合規 mask IPv4 第四段(spec 004 §7.3)
- preflight OPTIONS **不**寫 request log

### 9.2 與 Errors(spec 005)

- CORS 拒絕時,瀏覽器**自己**處理(server 端僅不發 `Access-Control-Allow-Origin`)
- backend 不主動拋 error 或回 403;遵守 W3C CORS 規範
- 若收到非預期 `Origin`,不寫 error log(會被搜尋引擎、心跳 probe 等正當流量觸發);改 sampled debug log

### 9.3 與 Rate-limit(spec 010)

- preflight OPTIONS 不套用 rate-limit(spec 010 §3.2 補追)
- `trustProxy` 設定**唯一**在本 spec(§6),spec 010 引用本 spec 結果

### 9.4 與 Health(spec 011)

- `/health/*` 端點仍套用本 spec 所有 security headers(防禦性深度,無成本)
- CORS 對 `/health/*` 預設**不開放**(health 端點不應被瀏覽器跨域呼叫;只有編排層內網存取);若特殊需求要對外開放 status,獨立 path + CORS 設定
- 不依賴 `@fastify/helmet` 開健康路徑,plugin lifecycle 一視同仁

### 9.5 與 API Response(spec 009)

- 所有 `exposedHeaders` 必須與 spec 009 §6 必有 / 條件 headers 一致;新增 response header 時**同步**更新 CORS exposed 清單(否則 BFF 讀不到)

### 9.6 與 Auth(spec 007 / 008)

- `allowedHeaders` 含 `Authorization`(Bearer token)
- backend 不依賴 cookie 認證;BFF 內部讀自己的 session cookie,再以 Bearer 呼叫 backend(spec 007 §2.2)
- 即使 backend 未來發 cookie,§8.2 規則必須遵守

---

## 10. 環境變數需求

新增(待併入 spec 001 §3.x 與 spec 002):

| Key | 必填 | dev 預設 | stage / prod | 說明 |
|---|---|---|---|---|
| `CORS_ORIGIN` | ✅(已於 spec 001 §3.6) | `http://localhost:3000` | 對應環境 BFF URL,逗號分隔多筆;**禁** `*` | |
| `CORS_PREFLIGHT_MAX_AGE_SEC` | | `600` | `600` | preflight cache |
| `HSTS_MAX_AGE_SEC` | | `31536000` | `31536000` | HSTS max-age |
| `HSTS_INCLUDE_SUBDOMAINS` | | `true` | `true` | HSTS includeSubDomains |
| `HSTS_PRELOAD` | | `false` | `false`(預設;domain 上線後評估) | 是否加 preload |
| `RATE_LIMIT_TRUSTED_PROXIES` | ✅(prod / stage)| (空)| 對應 LB / BFF 的 IP / CIDR | spec 010 §12 已提 |

---

## 11. 觀測性

### 11.1 Events(擴充 spec 004 §9.3)

| event | 觸發 | level | audit |
|---|---|---|---|
| `cors_origin_rejected` | 收到 `Origin` 不在 allowlist | debug | — |
| `cors_origin_allowed` | 命中 allowlist | (不 log,量大) | — |
| `trusted_proxy_misconfigured` | 啟動偵測到 `RATE_LIMIT_TRUSTED_PROXIES` 在 prod 為空 | fatal | — |

- `cors_origin_rejected` 用 debug level(高頻、可能來自 scanner / 心跳),避免 log 淹沒

### 11.2 Metrics(預留)

- `cors_origin_rejected_total{origin_hash}` — 反查惡意活動
- `security_header_set_total{header}` — 監控 helmet 是否正確套用

---

## 12. 測試

### 12.1 Unit

- CORS_ORIGIN parser(逗號分隔、trim、去重、拒 `*`)
- trustProxy CIDR parser(`10.0.0.0/8` 解析)
- X-Request-Id 格式驗證(非 UUID v4 → reject)

### 12.2 Integration

- 對受測 endpoint 發 OPTIONS preflight,驗證:
  - 允許 origin → 204 + 正確 `Access-Control-Allow-*` headers
  - 拒絕 origin → 204 但**無** `Access-Control-Allow-Origin`(讓 browser 自己擋)
- 對受測 endpoint 發 GET,驗證:
  - response 含 §4.1 全部必設 headers
  - 含 §5 CSP
  - 不含 `X-Powered-By`、`Server` 等指紋 headers
- 模擬偽造 `X-Forwarded-For` 但來自非受信任 IP → request.ip 仍是 socket IP,不被汙染

### 12.3 不測試

- helmet / cors 函式庫本身(信任上游)
- browser 端 CORS 機制(屬瀏覽器測試,非後端)
- TLS 握手(由部署層 / Cloudflare 負責)

---

## 13. 安全提醒

### 13.1 常見錯誤(本 spec 已防範)

1. **`origin: '*'` + credentials**:CORS spec 不允許;本 spec §3.2 禁用 `*`
2. **`trustProxy: true`**:信任所有 proxy → IP 偽造;本 spec §6.2 禁用
3. **HSTS 設 `preload` 但 domain 未準備好**:有去除困難;本 spec §7.2 預設關閉
4. **`X-Frame-Options: SAMEORIGIN` 對純 API 過寬**:本 spec §4.1 升 `DENY`
5. **忘了 expose response headers**:BFF 讀不到 `X-Request-Id` / `X-RateLimit-*`;本 spec §3.1 已列必設

### 13.2 升級流程

- 升 helmet 主版本前,review 預設值變化(已有 case 改變預設 → 影響 client)
- 新增 security header 採「先 Report-Only,再 Enforce」(若 CSP 升級時)
- 任何 header 變動需更新本 spec 並 PR review

---

## 14. 開放問題

- **HSTS preload 註冊**:domain 上線、穩定運作 1 個月後,評估申請 `https://hstspreload.org/`;一旦加入需確保所有子域永久 HTTPS
- **`Cross-Origin-Resource-Policy: same-site` vs `same-origin`**:本 spec 選 `same-site`(BFF 可跨子域消費);若日後嚴格隔離(不同 SLD)需調 `cross-origin`
- **`Permissions-Policy` 寫法**:目前列舉常見功能全關;新出現的 feature(如 `interest-cohort`)需追加
- **CSP Report 收集**:目前 `default-src 'none'` 不太會產 report,但加 `report-to` / `report-uri` 留作未來
- **Origin allowlist 動態化**:目前由環境變數靜態;若日後 SaaS 化(多個客戶 origin)需 dynamic store,但需嚴格 review 流程避免後門
- **`X-Forwarded-For` IPv6 處理**:目前以「第一個非受信任 IP」為準;IPv6 可能由 client 自填多個地址,需 strict parser

---

## 15. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-13 | 初版 |
