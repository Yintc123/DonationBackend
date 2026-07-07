# Spec 010:Rate-Limit 模組

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.5 |
| 日期 | 2026-06-13 |
| 適用範圍 | `backend/src/lib/rate-limit/*`、`backend/src/plugins/rate-limit.ts`、所有對外 endpoint |
| 相關 ADR | `docs/decisions/002-backend-framework.md` |
| 相關 spec | `006-redis-module.md`(`rate` tier、Lua、降級)、`009-api-response-and-http-status.md`(`X-RateLimit-*` / `Retry-After` headers、429)、`005-error-handling.md`(`RATE_LIMITED`)、`004-logger-module.md`、`008-auth-flow-password.md`(觸發者) |

---

## 1. 目的與範圍

### 1.1 目的

定義 backend 服務的限流(rate-limit)機制,提供:

- **DDoS 第一道防線**(全域 per-IP)
- **資源公平性**(per-user、per-route)
- **特定操作保護**(per-email 登入嘗試、per-account 密碼變更)
- **可預測的 client 體驗**(`X-RateLimit-*` headers、`Retry-After`)
- **安全降級**(Redis 不可用時 fail-closed)

### 1.2 In scope

- 演算法選型(sliding window counter)
- 多層次限流(global / per-route / per-actor / per-purpose)
- Per-route 設定 API
- 與 Redis `rate` tier(spec 006)整合
- 與 spec 009 response headers 整合
- 與 spec 005 錯誤回應整合
- 例外清單(allowlist)
- 觀測與測試

### 1.3 Out of scope(本期或後續)

- **應用層 throttle**(client-side back-pressure)— 屬 BFF / 前端
- **WAF / IDS / 4-layer DDoS**(SYN flood 等)— 基礎設施層處理
- **CAPTCHA / 人機驗證** — 後續(rate-limit 觸發後的補強)
- **動態調整限制**(real-time 自動上下調)— 後續
- **多 region 全域一致性** — 單 region 起步,後續評估
- **業務語意的「配額」**(monthly quota)— 不是限流,屬業務 spec

---

## 2. 演算法:Sliding Window Counter(近似)

### 2.1 選擇結論

採 **Sliding Window Counter (approximation)**,以 Lua script 原子處理。

### 2.2 為什麼

| 演算法 | 優 | 缺 | 結論 |
|---|---|---|---|
| **Fixed window** | 實作最簡單,單 INCR + EXPIRE | 視窗交界處可爆量(連續兩窗各打滿即實際 2× 限制) | ❌ 安全性不足 |
| **Sliding window log** | 完全精確 | 每 key 存所有 timestamp,記憶體 O(N) 爆炸 | ❌ 不可擴展 |
| **Sliding window counter (approx)** | 接近精確、記憶體 O(1)(兩個整數) | 算近似值,邊界誤差 < 10% | ✅ 採用 |
| **Token bucket** | 允許可控 burst、靈活 | 適合公平資源排程,對「阻擋暴力嘗試」語意較弱 | 預留:burst 端點再啟用 |
| **Leaky bucket** | 平滑輸出 | 對 API 限流過於嚴格,且需 background tick | ❌ 不採用 |

### 2.3 近似公式

設視窗 `W` 秒、當前時間在當前窗已過 `e` 秒。

```
count = previousWindowCount × (1 − e / W) + currentWindowCount
```

- `previousWindowCount`:上一個 W 秒窗的計數
- `currentWindowCount`:當前窗的計數
- 若 `count + cost > limit` → 拒絕

### 2.4 Lua 草案

```lua
-- KEYS[1] = prev key, KEYS[2] = current key
-- ARGV: window, limit, cost, nowMs

local windowMs = tonumber(ARGV[1])
local limit    = tonumber(ARGV[2])
local cost     = tonumber(ARGV[3])
local nowMs    = tonumber(ARGV[4])
local elapsed  = nowMs % windowMs
local prev     = tonumber(redis.call('GET', KEYS[1]) or '0')
local curr     = tonumber(redis.call('GET', KEYS[2]) or '0')

local estimate = prev * (1 - elapsed / windowMs) + curr
if estimate + cost > limit then
  local resetMs = windowMs - elapsed
  return {0, math.floor(limit - estimate), resetMs}      -- denied
end

redis.call('INCRBY', KEYS[2], cost)
redis.call('PEXPIRE', KEYS[2], windowMs * 2)              -- 涵蓋下個窗
return {1, math.floor(limit - estimate - cost), windowMs - elapsed}  -- allowed
```

- script 一次完成「讀 + 估算 + 寫」,原子無 race
- key 命名 `jkod:rate:<...>:<windowStart>` 內含視窗起點,自然分窗
- `PEXPIRE` 設 `windowMs * 2`,確保「下一窗讀到上一窗」仍有效

---

## 3. 限制層次(Layered Limits)

### 3.1 同時套用的 4 層

每個請求**依序檢查**下列層,**任一層拒絕即 429**(取 `Retry-After` 最大者):

| 層 | 範圍 | 預設限制 | 用途 |
|---|---|---|---|
| **L1 Global per-IP** | 同 IP 所有路徑加總 | 600 / 分鐘 | 防 DDoS 第一道 |
| **L2 Per-route per-IP** | 該路徑 × 該 IP | 路徑自訂(範例:auth login 30 / 分) | 路徑層防暴力 |
| **L3 Per-route per-user** | 該路徑 × 該 user(已登入) | 路徑自訂 | 防單用戶濫用 |
| **L4 Per-purpose**(自訂 key) | 例:per-email 登入計數 | 路徑自訂 | 業務需求(spec 008 §7) |

### 3.2 規則

- 未登入時 L3 退化為 L2(以 IP 為 user proxy)
- L4 由路徑顯式宣告 key 模板與限制;預設不啟用
- 多層命中 → 回 **最嚴格層** 的 `X-RateLimit-*`,`Retry-After` 取最長
- L1 不可關閉;L2-L4 可路徑層級豁免

---

## 4. Key Naming(呼應 spec 006 §4)

格式:`jkod:rate:<scope>:<identifier>:<windowStartMs>`

| Scope | 範例 |
|---|---|
| L1 Global per-IP | `jkod:rate:global:ip:{ip}:{windowStart}` |
| L2 Per-route per-IP | `jkod:rate:route:{routeId}:ip:{ip}:{windowStart}` |
| L3 Per-route per-user | `jkod:rate:route:{routeId}:user:{userId}:{windowStart}` |
| L4 Per-purpose | `jkod:rate:purpose:{purposeName}:{identifierHash}:{windowStart}` |

### 4.1 規則

- `routeId`:Fastify route 唯一 id(`<method>:<routePath>`,例 `POST:/v1/auth/login`)
- `ip`:來源 IP;經 BFF 時取 `X-Forwarded-For` 第一段(部署 spec 內配置受信任 proxy)
- `userId`:JWT 中的 accountId(spec 007 §11.1)
- 含 PII 的 identifier(例 email)**必須先 hash**:`SHA256(value).slice(0, 16)`,避免 Redis dump 含明文
- key 內**禁出現** `*` / `?` / 空白(spec 006 §4.3)

---

## 5. Per-Route 設定 API

### 5.1 宣告方式

每個 route 在 schema 旁宣告 rate-limit 設定:

```ts
fastify.post('/v1/<resource>', {
  schema: { ... },
  config: {
    rateLimit: {
      // L2 per-route per-IP
      perIp:   { limit: 30, windowMs: 60_000 },
      // L3 per-route per-user(預設沿用 perIp 的 limit/window,可覆寫)
      perUser: { limit: 60, windowMs: 60_000 },
      // L4 per-purpose(可選,多個)
      purposes: [
        {
          name: 'login_email',
          identifier: (req) => sha256(req.body.email).slice(0, 16),
          limit: 10,
          windowMs: 3_600_000,    // 1 hour
        },
      ],
      // cost(預設 1;高成本端點調高)
      cost: 1,
      // 豁免(預設 false)
      bypass: (req) => isInternalIp(req.ip) || req.user?.role === 'admin',
    },
  },
}, handler)
```

### 5.2 規則

- **L1 global** 由 plugin 全域套用,不在 route 宣告
- 未設 `config.rateLimit` 的 route 套用**預設 L2**:`{ limit: 120, windowMs: 60_000 }`(每分鐘 120 次)
- `purposes` 內每個 purpose 名稱**全域唯一**(便於 log / metric);新增需 PR 中審查
- `bypass` 為 sync 函式,不可做 IO

### 5.3 Cost(請求權重)

- 預設每次呼叫消耗 1 cost
- 重度端點(例:大 list 查詢、密集 DB 寫入)可宣告 `cost: 5`,即一次呼叫等同 5 次
- cost 用於 L1 + L2 + L3 + L4 同步扣抵(避免「重度端點」靠多打輕度端點繞過)

---

## 6. 函式庫

### 6.1 採用

- **`@fastify/rate-limit`** plugin 提供:per-route 設定的 plumbing、429 回應自動產生、`config.rateLimit` 約定
- 但**替換內建 store** 為自家 Redis store,實作 sliding window Lua(§2.4)

### 6.2 為什麼不全用內建

- `@fastify/rate-limit` 預設算法為 fixed window(允許邊界爆量,§2.2)
- 自家 store 仍可吃 `@fastify/rate-limit` 的 plumbing(plugin lifecycle / per-route config / header injection),只需實作 `incr(key, ttl) → { current, ttl }` 介面變形;本 spec 改實作為 sliding 形式

### 6.3 自家 store 結構草案

```ts
// src/lib/rate-limit/store.ts(草案)
import type { FastifyRedis } from '@fastify/redis'

export interface SlidingWindowStore {
  hit(args: {
    key: string                 // 不含 windowStart 後綴,由 store 內部分段
    windowMs: number
    limit: number
    cost?: number
  }): Promise<{
    allowed: boolean
    remaining: number
    resetInMs: number
  }>
}

export function createSlidingWindowStore(redis: FastifyRedis): SlidingWindowStore {
  // 啟動時 SCRIPT LOAD,取 sha;往後 evalsha
  // hit() 計算 prev/curr key 後呼叫 evalsha
}
```

---

## 7. Response Headers(對齊 spec 009)

### 7.1 必有

| Header | 內容 |
|---|---|
| `X-RateLimit-Limit` | 該層 limit(整數) |
| `X-RateLimit-Remaining` | 該層剩餘(整數,不會 < 0) |
| `X-RateLimit-Reset` | 視窗結束的 epoch seconds(整數) |

### 7.2 條件

| Header | 何時 |
|---|---|
| `Retry-After` | 拒絕時(429)— 秒數,= `resetInMs / 1000` 向上取整 |
| `X-RateLimit-Layer` | 多層命中時揭露**最嚴格層**(`global` / `route-ip` / `route-user` / `purpose:<name>`) |

### 7.3 規則

- 多層通過時,headers 取**剩餘最少**那層
- 多層拒絕時,headers 取**剩餘最少**那層(同上),`Retry-After` 取**最長**
- 不揭露 `X-RateLimit-Cost`(避免攻擊者反推路徑成本)

---

## 8. 拒絕回應

### 8.1 對外 shape(承 spec 005 §6 RFC 7807)

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/problem+json
Retry-After: 42
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1781317200
X-RateLimit-Layer: route-ip

{
  "type": "https://api.<host>/errors/rate-limited",
  "title": "Too many requests",
  "status": 429,
  "code": "RATE_LIMITED",
  "detail": "Too many requests. Please retry after 42 seconds.",
  "instance": "/v1/<path>",
  "requestId": "<uuid>"
}
```

### 8.2 例外:Auth 帳號鎖

spec 008 §5.3 定義的 per-email lock 觸發時 `code: AUTH_ACCOUNT_LOCKED`(不洩漏「帳號存在」訊息),但 HTTP status 與 `Retry-After` 規則同上。

---

## 9. 例外 / 白名單

### 9.1 不套用 rate-limit 的路徑與 method

- **`/health/*` 全部端點**(spec 011 §3):`/health/live`、`/health/ready`、`/health/startup`、`/health`、`/health/db`、`/health/cache`
- **`/docs` 與 `/docs/*`**(spec 016 §12.1):Swagger UI bundle + 其底下由 `@fastify/static` 註冊的 wildcard 靜態路由(`routeOptions.url` 字面含 `*`,會撞 §4.3 的 routeId 驗證);openapi plugin 在 production 為 no-op,因此實務上是 dev-only 豁免
- **任何路徑的 `OPTIONS` preflight**(spec 012 §3.6):CORS preflight 不算正常請求,計入會引發 BFF 高頻打嗝撐爆計數
- (未來)`GET /metrics`(由部署層另控)

### 9.2 不套用 rate-limit 的來源

> **未實作 / 規劃中(v0.5)**:目前 `src/lib/rate-limit/skip.ts:37-48` 只豁免 OPTIONS preflight、`/health/*`、`/docs*`(§9.1),**尚未**實作下列「內網 / 私有 IP 來源豁免」。以下為目標設計。

- **內網 IP**(RFC 1918:`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`)+ `127.0.0.0/8` + IPv6 link-local
- 由 BFF / load balancer 帶 `X-Forwarded-For` 時,以該值末段(或受信任 proxy 過濾後的真實 IP)為準
- 部署層**必須**設定受信任 proxy 範圍(Fastify `trustProxy`),否則攻擊者可偽造 IP 繞過

### 9.3 部分豁免(只豁免特定層)

| 來源 | 豁免層 |
|---|---|
| 內網(**未實作,見 §9.2**)/ health(已實作) | L1 + L2 + L3 + L4 |
| `req.user.role === 'admin'` | 由路徑 `bypass` 決定;預設**不**豁免 L1 |
| Idempotency-Key 重放(spec 009 §7) | 全豁免(重放是同一動作,不應重複扣) |

### 9.4 全域 kill switch — `RATE_LIMIT_DISABLED`

env `RATE_LIMIT_DISABLED=true` 時,`rateLimitPlugin` 偵測到後**直接 return,不註冊任何 preHandler hook**:

- 每條請求繞過全部 4 層(L1 / L2 / L3 / L4),不打 Redis、不 stamp `X-RateLimit-*` headers、不會回 429 / 503
- 啟動時印一條 `WARN { event: 'rate_limit_disabled' }`,ops 看 log 必能察覺
- 與 §9.2 「豁免來源」獨立:來源規則只移除特定 IP 段,kill switch 是「整個模組停用」
- 用途:demo / live tour / 壓測探勘期間「先確定功能對」再開限流。**不是 prod-grade 緊急逃生口** — 真要用就是事故當下手動翻
- 預設:`false`(schema default;`.env.example` 同步)。本 demo 專案在 `.env` + `.env.prod` 各自設 `true`,因為交付物是「能完整 click through 的 UI」,rate-limit 不在評審範圍

---

## 10. 失敗策略(Redis 不可用)

承 spec 006 §11.3:`rate` tier 預設**失敗關閉**。

| 場景 | 行為 |
|---|---|
| Redis 連線失敗 / 超時 | **503 `SERVICE_UNAVAILABLE`**(`code: 'RATE_LIMIT_UNAVAILABLE'`),`Retry-After: 5` |
| Lua script 錯誤(programmer error) | 500 `INTERNAL_ERROR`(spec 005 §11.2) |

### 10.1 例外:失敗開放(opt-in)

(v0.5 — 同步實作)fail-open **不是** per-route 設定:實際只由**全域** env `RATE_LIMIT_FAILURE_MODE=open` 驅動,一翻即對所有 route 生效(`src/lib/rate-limit/plugin.ts:76`、失敗分支 `:125-131`)。**沒有** per-route `failureMode: 'open'` 這個選項(§5.1 的 route config 亦無此欄位)。本期預設 `closed`;若日後需要「某些公共 / 匿名端點才放行」,須另實作 per-route 覆寫。

### 10.2 規則

- 失敗關閉**不能繞過**;管理端點若需逃生通道,走獨立 path + IP 白名單(§9.2)
- log `event: rate_limit_redis_unavailable`,便於告警(spec 004 §9.3 之擴充)

---

## 11. 與其他模組整合

### 11.1 與 Redis(spec 006)

- 全部 keys 屬 `rate` tier;TTL 必填(= `windowMs × 2`)
- 不混用 `cache` / `auth` 等 tier
- key 命名前綴 `jkod:rate:*`(§4)
- 降級行為由 spec 006 §11.3 規範,本 spec 不重述

### 11.2 與 Errors(spec 005)

- 拒絕回應走 `application/problem+json`(spec 005 §6)
- `code` 字典貢獻:`RATE_LIMITED`(已存在於 spec 005 §4.2)、新增 `RATE_LIMIT_UNAVAILABLE`(503)
- `errorHandler` 不必為 rate-limit 特殊處理;throw `TooManyRequestsError` / `ServiceUnavailableError` 即可

### 11.3 與 Logger(spec 004)

| event | 觸發 | level | audit |
|---|---|---|---|
| `rate_limit_blocked` | 任一層拒絕 | warn | — |
| `rate_limit_redis_unavailable` | Redis 不可用 → 失敗**關閉**(closed) | error | — |
| `rate_limit_check_failed` | Redis 呼叫失敗且 `RATE_LIMIT_FAILURE_MODE=open` → 失敗**開放**放行(v0.5 — 同步實作,`src/lib/rate-limit/plugin.ts:127`) | error | — |
| `rate_limit_bypass` | 豁免路徑觸發 bypass | debug | — |
| `rate_limit_disabled` | 啟動時 `RATE_LIMIT_DISABLED=true`(§9.4) | warn | — |

- log 中**禁出現**原始 IP / email;以 `ipHash` / `identifierHash` 表示
- 高頻 event 不寫 audit log;轉 metric 由未來 metrics spec 處理

### 11.4 與 Response 規約(spec 009)

- Headers 命名與 spec 009 §6.2 一致
- 429 status code 屬 spec 005 錯誤路徑,Content-Type 為 `application/problem+json`

### 11.5 與 Auth(spec 007 / 008)

- spec 008 §7 的 5 個 rate-limit key 模板由本 spec 的 L4 purposes 機制實作
- spec 007 的 `/auth/refresh` / `/auth/google/exchange` 走預設 L2 per-IP

---

## 12. 環境變數需求

新增(待併入 spec 001):

| Key | 必填 | dev 預設 | 說明 |
|---|---|---|---|
| `RATE_LIMIT_GLOBAL_PER_IP_LIMIT` | | `600` | L1 限制 |
| `RATE_LIMIT_GLOBAL_PER_IP_WINDOW_SEC` | | `60` | L1 視窗 |
| `RATE_LIMIT_DEFAULT_LIMIT` | | `120` | 路徑未指定時的 L2 預設 |
| `RATE_LIMIT_DEFAULT_WINDOW_SEC` | | `60` | 同上 |
| `RATE_LIMIT_FAILURE_MODE` | | `closed` | `closed` / `open`(目前固定 closed) |
| `RATE_LIMIT_TRUSTED_PROXIES` | | (空,dev 不需) | 受信任 proxy IP / CIDR,逗號分隔 |

---

## 13. 測試

呼應 backend `CLAUDE.md`:不 mock Redis;用 `testcontainers`。

### 13.1 Unit

- Lua 公式:給定 prev/curr/elapsed,驗證估算正確
- Key 名稱組裝
- Cost 與 limit 邊界(`cost = limit` 應允許、`cost = limit + 1` 應拒絕)

### 13.2 Integration

- 對受測 route 連續 `fastify.inject()` 直至 429,驗證:
  - 在 `limit` 次內允許
  - 超過後 429 + Retry-After
  - 視窗推進後重新允許
- 多層測試:讓 L2 與 L4 同時命中,驗證 headers 取最嚴格層
- 失敗關閉:暫停 Redis container,驗證 503 + `RATE_LIMIT_UNAVAILABLE`

### 13.3 時間控制

- 用 `vi.useFakeTimers()` 推進 wall-clock,搭配 Redis container 真實 TTL
- Redis 內 TTL 不受 fake timer 影響;靠 script 內 `nowMs` 由 server 傳入,測試時可控
- script 用 `ARGV[4] = nowMs`(§2.4)便於測試注入時間

---

## 14. 觀測性

### 14.1 Metrics(預留,留待 metrics spec)

- `rate_limit_decisions_total{layer, decision="allow|deny"}` — counter
- `rate_limit_redis_unavailable_total` — counter
- `rate_limit_remaining_ratio{layer}` — histogram(限剩餘比例)

### 14.2 Log 規則

- 拒絕 log 包含 `layer`、`limit`、`windowMs`、`identifierHash`(不含原始 IP / email)
- 高頻 deny event 採 sampled log(每 100 次寫一次,留 metric 全量計)— 本期不啟用,流量大時再開

---

## 15. 安全

### 15.1 IP 信任

- **必須**配置 `trustProxy`,只信任部署層 BFF / load balancer 的 IP
- 不可直接信任 `X-Forwarded-For`,否則攻擊者可任意偽造繞過

### 15.2 Key Cardinality 攻擊

- key 含 `identifier` 段;攻擊者若能任意撐爆 cardinality(例:用 1000 萬個假 email 觸發 L4)會耗 Redis 記憶體
- 防護:`identifier` 必 hash 並截斷(§4.1)、`rate` tier TTL 確保 keys 自然過期、Redis 啟用 `maxmemory` 與 `volatile-lru`(spec 006 §10.2)

### 15.3 跨層繞過

- 不可只設 L4 而不設 L2;**L2 為 baseline**(預設值)
- bypass 函式必須**極簡且不可被使用者操控**(例:不可依 body 內容決定 bypass)

### 15.4 觸發後行為

- 429 響應**不洩漏**:剩餘多久(秒數已揭露)以外的細節
- 不揭露「哪個 identifier 觸發」(避免被列舉)
- `auth_account_locked`(spec 008 §5.3)的特殊訊息已要求一致(不揭露帳號存在)

---

## 16. 開放問題

- **演算法升級為 token bucket**:若日後出現「允許 burst 但維持平均」的端點,可在 store 內加 token bucket 模式,以 `algorithm: 'token-bucket'` 選用
- **多 region 同步**:單 region 起步;跨 region 需要 conflict-free 計數,複雜度高,留作未來
- **動態調整**:`POST /admin/rate-limit/<routeId> { limit }` 需 admin auth + audit,待 admin spec
- **CAPTCHA 觸發**:rate-limit 觸發 N 次後,改要求 CAPTCHA 通過才繼續;需 BFF 合作
- **IPv6 子網計**:目前以單 IP 為 key;IPv6 可能讓攻擊者用單一 prefix 內大量地址繞過,可改 `/64` 子網為計數單位
- **`X-RateLimit-*` 標準化**:`RateLimit` / `RateLimit-Policy` 為 IETF draft;標準成熟後切換
- **不同來源類別不同預設**:`/v1/public/*` 對匿名匯入較嚴、`/v1/internal/*` 對內部較寬;由路徑前綴自動套用 preset

---

## 17. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-13 | 初版 |
| 0.2 | 2026-06-13 | §9.1 豁免清單由 `/health` / `/health/db` / `/health/cache` 三個擴為「`/health/*` 全部端點」(對齊 spec 011 §3 的 6 端點),並補 OPTIONS preflight 豁免(對齊 spec 012 §3.6)|
| 0.3 | 2026-06-16 | §9.1 補 `/docs` + `/docs/*` 豁免;Swagger UI 經 `@fastify/static` 註冊的 wildcard 路由會讓 §4.3 routeId 驗證 throw,導致 `/docs/static/*.css\|js\|png` 全數回 503 RATE_LIMIT_UNAVAILABLE,實務上 Swagger UI 整個打不開 |
| 0.5 | 2026-07-07 | **同步實作**:§9.2 / §9.3 內網 / 私有 IP(RFC1918 + loopback + IPv6 link-local)來源豁免標「未實作 / 規劃中」——`skip.ts:37-48` 目前只豁免 OPTIONS / `/health/*` / `/docs*`;§10.1 更正 fail-open **無** per-route `failureMode:'open'`,只由全域 env `RATE_LIMIT_FAILURE_MODE` 驅動(`plugin.ts:76,125-131`);§11.3 補未文件化事件 `rate_limit_check_failed`(fail-open 分支,`plugin.ts:127`)與 `rate_limit_disabled` |
| 0.4 | 2026-06-16 | §9.4 新增全域 kill switch `RATE_LIMIT_DISABLED`:env 旗標翻 true → plugin 直接 return 不註冊 preHandler,所有 4 層繞過。demo 專案 `.env` + `.env.prod` 預設 ON,`.env.example` + schema default OFF。落實檔:`src/config/schema.ts`、`src/lib/rate-limit/plugin.ts`、`tests/integration/rate-limit.test.ts`(2 個新 case:kill-switch + control) |
