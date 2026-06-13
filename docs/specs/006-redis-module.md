# Spec 006:Redis 模組(Cache / Auth state / Rate-limit / Lock)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.1 |
| 日期 | 2026-06-13 |
| 適用範圍 | `backend/src/lib/cache`、`backend/src/plugins/redis.ts` |
| 相關 ADR | `docs/decisions/002-backend-framework.md`、`docs/decisions/004-auth-token-strategy.md`(refresh token 存 Redis + AOF) |
| 相關 spec | `001-environment-config.md`(`REDIS_URL`)、`004-logger-module.md`、`005-error-handling.md` |

---

## 1. 目的與範圍

### 1.1 目的

定義 Redis 在本服務中的使用規約,避免「Redis 變成什麼都能塞的雜物櫃」這個常見反模式。Redis 同時承擔四種角色:

1. **Cache**:可重算結果的暫存
2. **Auth state**:refresh token / access token blacklist(ADR 004)
3. **Rate-limit**:時間窗計數器
4. **Lock**:分散式互斥

每種角色對「可遺失性 / TTL / eviction / 持久化」的要求不同;本 spec 用 key 命名 + eviction policy + TTL 規則把它們**分區治理**。

### 1.2 In scope

- 函式庫選型與 Fastify plugin 結構
- 連線生命週期、錯誤與重連策略
- Key namespace、用途分類、TTL 規則
- 資料型別、序列化、原子操作
- Cache 模式(cache-aside、stampede)
- 持久化(AOF / RDB)、eviction、記憶體
- 安全(AUTH / TLS / 網路)
- 觀測性與測試

### 1.3 Out of scope(後續另立)

- Pub/Sub 訊息匯流排 — 目前無使用情境
- Redis Cluster / Sentinel 部署細節 — 單節點起步
- Stream(消息佇列)— 若日後引入背景工作再評估
- 業務層 cache 策略(哪些查詢值得 cache、命中率目標)— 由業務 spec 決定

---

## 2. 函式庫選型

採用 **`ioredis`**(透過 `@fastify/redis` plugin 包裝)。

### 2.1 理由

- ioredis 是 Node 生態 Redis client 的事實標準;原生 Cluster / Sentinel / Lua / pipeline 支援
- `@fastify/redis` 提供 lifecycle 整合(register / onClose),零黏合層
- 官方 `node-redis`(v4+)API 較新但 Lua / Cluster 體驗略弱,生態文件較少
- 自寫 wrapper 易與 plugin lifecycle 衝突,維護成本不划算

### 2.2 不採用的替代方案

- `node-redis` — 可行但生態文件偏少;若日後 cluster 需求降低可重評
- `keyv` / `cache-manager` — 多後端抽象層;對本專案多種用途(token / lock)而言抽象過頭、會丟失 Redis 原生能力(Lua、pipeline)

---

## 3. 連線生命週期與 Plugin

### 3.1 結構草案

```ts
// src/plugins/redis.ts(草案)
import fp from 'fastify-plugin'
import fastifyRedis from '@fastify/redis'

declare module 'fastify' {
  interface FastifyInstance {
    // @fastify/redis 注入的 ioredis instance
    redis: import('ioredis').Redis
  }
}

export default fp(async (fastify) => {
  await fastify.register(fastifyRedis, {
    url: fastify.config.REDIS_URL,
    // 連線與重試設定見 §12
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    // TLS:由 URL scheme rediss:// 自動啟用,或在此明示
  })

  // 連線事件 → logger(module: 'cache')
  const log = fastify.log.child({ module: 'cache' })
  fastify.redis.on('ready',        () => log.info({ event: 'cache_connected' }, 'redis ready'))
  fastify.redis.on('error',  (err) => log.error({ event: 'cache_error', err }, 'redis error'))
  fastify.redis.on('close',        () => log.warn({ event: 'cache_disconnected' }, 'redis closed'))
  fastify.redis.on('reconnecting', () => log.warn({ event: 'cache_reconnecting' }, 'redis reconnecting'))
})
```

### 3.2 規則

- **單一連線 instance**:整個 process 共用,**不在 request scope 建新連線**;批次工作有特殊需求才另開
- **連線於 `register` 階段建立**(`lazyConnect: false`),啟動失敗即 fail-fast(spec 001 §1 原則)
- **`onClose` 由 plugin 處理**(Fastify shutdown 流程觸發 `redis.quit()`)
- **業務代碼禁直接 `import Redis from 'ioredis'`**,一律走 `fastify.redis` 或 §16 提供的 helper

---

## 4. Key Namespace 規約

### 4.1 格式

```
<app>:<purpose>:<sub-namespace>:<identifier>
```

- **`<app>`**:應用前綴(本專案固定 `jkod`),避免共用 Redis 時跨應用衝突
- **`<purpose>`**:用途分類(見 §5),`cache` / `auth` / `rate` / `lock` / `job` 五種之一
- **`<sub-namespace>`**:purpose 內的子分類(`refresh`、`blacklist`、`ip`、...)
- **`<identifier>`**:具體 key(可有多段,以 `:` 分隔)

### 4.2 範例

| Key | 說明 |
|---|---|
| `jkod:cache:profile:{id}` | 某個資源 profile 的查詢快取 |
| `jkod:auth:refresh:{tokenId}` | refresh token 雜湊與 metadata(ADR 004) |
| `jkod:auth:refresh:user:{userId}` | 某 user 的 refresh tokenId Set |
| `jkod:auth:blacklist:{jti}` | access token 緊急撤銷 blacklist |
| `jkod:rate:ip:{ip}:{windowKey}` | rate-limit 計數器(以 IP + 時間窗) |
| `jkod:lock:{resourceType}:{id}` | 分散式鎖 |
| `jkod:job:queue:{name}` | 任務佇列(若引入) |

> identifier 段中的變數(`{id}` 等)**禁止**為使用者輸入直接拼接;必須先驗證(UUID format / 白名單)以防 key injection(雖無 SQL injection 後果嚴重,但會造成 namespace 污染與 cardinality 爆炸)。

### 4.3 規則

- **新增 purpose 需更新本 spec § 5 表**;reviewer 在 PR 中比對
- **不**用空白 / 特殊字元 / 中文(影響 log 可讀性)
- **不**以 `*` / `?` / `[]` 作為 identifier(會與 SCAN MATCH 衝突)
- 跨 environment 不靠 namespace 隔離,由 **獨立 Redis instance** 保證(spec 001 §3.3)

---

## 5. Key 用途分類(Tier)

**核心治理表**——每個 key 必須屬於下列之一,決定它的 TTL、eviction、持久化要求。

| Tier | purpose 前綴 | 可否遺失 | TTL | 持久化 | Eviction 容忍 | 範例 |
|---|---|---|---|---|---|---|
| **Cache** | `cache` | ✅ 可,失效後重算 | **必填**,通常 ≤ 1h | RDB 即可 | 可 evict | 查詢結果暫存 |
| **Auth state** | `auth` | ❌ 不可,失效=被迫重登 | 必填,= token 壽命(ADR 004) | **AOF 必開** | **不可 evict** | refresh token、access blacklist |
| **Rate-limit** | `rate` | ⚠️ 可(短期 race 容忍) | 必填,= 時間窗 | RDB 即可 | 可 evict | 計數器 |
| **Lock** | `lock` | ⚠️ 可(TTL 自然釋放即正確) | **必填**,防死鎖 | RDB 即可 | 可 evict(TTL 過了等同釋放) | 分散式鎖 |
| **Job** | `job` | ❌ 不可(會掉任務) | 視業務 | **AOF 必開** | 不可 evict | 任務佇列(若引入) |

### 5.1 規則

- **所有 key 必有 TTL**(`EXPIRE` 或 `SET EX`);無 TTL 的 key 在 PR review 必須出示理由
- Tier 互相**禁混用 key**:rate-limit 與 cache 不可共用同個 key 名
- Eviction 策略以**最嚴格 tier**為準(見 §10.2):有 auth / job 即不可用 `allkeys-*` 政策

---

## 6. TTL 政策

### 6.1 預設

| Tier | 建議 TTL | 上限 |
|---|---|---|
| cache | 60s ~ 10min | 1h(超過者重新評估是不是 cache) |
| auth refresh | 30d(ADR 004) | — |
| auth blacklist | = access token 剩餘壽命 | 3h(access 壽命) |
| rate-limit | = 視窗長度 | — |
| lock | 5s ~ 30s,預設 10s | 60s(超過視為設計問題) |
| job | 視業務 | — |

### 6.2 規則

- TTL 透過 `SET key value EX <seconds>` 或 `SETEX` 在**寫入時**同步設定,**不**用兩步 `SET → EXPIRE`(中間 crash 會永存)
- TTL 更新(refresh sliding window)用 `EXPIRE` 或 `SET KEEPTTL`(Redis 6+)
- **絕不**用 `PERSIST` 把 TTL 拿掉
- TTL 為 `0` 或負數 = 立即刪除,**不**作為「永不過期」用法

---

## 7. 資料型別與序列化

### 7.1 資料型別選擇

| Redis type | 適用 | 不適用 |
|---|---|---|
| String | 簡單值、JSON blob | 大物件(>100KB) |
| Hash | 結構化 record(欄位獨立讀寫) | 欄位數 >100 時改 string |
| Set | 集合關聯(user → tokenIds) | 需排序時 |
| Sorted Set | 排行 / 時間軸 / 過期掃描 | 一般集合 |
| List | FIFO / LIFO queue(短) | 大量持久任務(改 Stream) |
| Stream | 持久化事件流(out of scope 本 spec) | — |

### 7.2 序列化

- **JSON** 為預設;欄位命名 `camelCase`,與 Prisma 慣例一致
- **禁用** `JSON.stringify` 直接處理 `Date` / `BigInt`(會丟資訊或拋錯)— 自訂 replacer 或先 `.toISOString()`
- **避免** binary blob;若必要(如 hashed token),用 `base64url` 表示
- value **上限 100KB**;超過視為設計味道,需 review

### 7.3 範例

```ts
// 寫入結構化資料(Hash 形式)
await fastify.redis.hset(`jkod:auth:refresh:${tokenId}`, {
  userId,
  hashedToken,      // sha256 hex
  createdAt: new Date().toISOString(),
})
await fastify.redis.expire(`jkod:auth:refresh:${tokenId}`, REFRESH_TTL_SEC)

// 寫入單一 JSON blob(String 形式)
await fastify.redis.set(
  `jkod:cache:profile:${id}`,
  JSON.stringify(profile),
  'EX', 600,
)
```

---

## 8. 原子操作

### 8.1 三種工具,使用優先序

1. **Single command**:能用一個命令解決就用一個(`SET NX EX`、`INCR EX`、`HSETNX`)
2. **Lua script (`EVAL` / `EVALSHA`)**:多步驟邏輯需原子性的首選——一次 round trip、單執行緒保證
3. **MULTI / EXEC**:批次但不需條件;Watch + MULTI 用於樂觀鎖(較少用)

### 8.2 為什麼偏好 Lua over MULTI

- Lua 可在原子序列中根據前一步結果分支(`if redis.call('GET', ...) ...`)
- MULTI 內無法看前一步結果(只能批次提交)
- 多數「原子組合」需求(rate-limit 增減 + 過期、blacklist 寫入 + 限期)Lua 寫起來更清楚

### 8.3 規則

- Lua script **集中於 `src/lib/cache/scripts/`**,每個 script 一個檔案,export `{ source, sha?, numKeys }`
- 使用端走 `redis.evalsha`,sha 在啟動時 `SCRIPT LOAD` 一次後 cache
- script **必須是 idempotent**(同樣輸入結果一致),否則 retry 會出錯
- script **不可阻塞**(無 BLPOP / 大迴圈);Redis 單執行緒,阻塞 = 全局停擺

### 8.4 Pipelining

- 批次無相依命令一律走 `pipeline()`(節省 N 次 round trip)
- pipeline ≠ 原子;需要原子用 Lua

---

## 9. Cache 模式

### 9.1 預設模式:Cache-aside(Lazy load)

```
read:
  v = GET key
  if v: return v
  v = source-of-truth(SoT)
  SET key v EX ttl
  return v

write:
  update SoT
  DEL key   // 不要 SET 新值(避免 race;讀者重新 load)
```

### 9.2 規則

- **預設用 cache-aside**,不採 write-through(額外複雜度,本專案不需)
- 寫入後**刪 key,不更新 key**——更新易與並發讀者交錯造成 stale-after-write
- **不快取空結果**作為「不存在」訊號(易導致 negative cache 爆量);需要時用獨立 sentinel value 並短 TTL(30s)

### 9.3 Stampede(thundering herd)防護

當高熱 key 過期瞬間,大量請求同時 miss → 同時打 SoT,壓垮下游。

| 方案 | 適用 | 規則 |
|---|---|---|
| **Request coalescing**(in-process) | 單 instance、短時間 | route handler 用 `lru-cache` + `Promise` 共享,避免同 process 多次穿透 |
| **Probabilistic early refresh** | 高熱、可容忍稍 stale | 接近 TTL 末段時部分請求觸發 refresh,其餘繼續用舊值 |
| **Distributed lock** | 跨 instance、SoT 計算昂貴 | 用 §5 Lock tier:`SET NX EX` 取鎖,失敗者等再讀 cache |

預設不主動啟用,**等實測有 stampede 才導入**(避免過度設計)。

---

## 10. 持久化與 Eviction

### 10.1 持久化(AOF / RDB)

| 環境 | AOF | RDB | 說明 |
|---|---|---|---|
| dev | off | off | 重啟丟資料無痛 |
| stage | on(`appendfsync everysec`) | on(預設) | 模擬 prod 行為 |
| prod | **on(`appendfsync everysec`,必開)** | on(快速冷啟動) | ADR 004 要求:refresh token 不能因重啟全失效 |

ADR 004 §「為什麼 refresh 存 Redis」明示:**Redis flush / 重啟 = 全使用者重登**;AOF 是降低這風險的唯一手段。

### 10.2 Eviction Policy

| 場景 | maxmemory-policy | 理由 |
|---|---|---|
| 純 cache 用途的 Redis | `allkeys-lru` | 記憶體滿即丟最舊 |
| **本專案(混合 auth/cache)** | **`volatile-lru`** | 只 evict 有 TTL 的 key(所有 key 都有 TTL,但語意上保護「不可丟」分區從 evict 中排除為策略前提) |
| 純 source-of-truth(job queue) | `noeviction` | 寧可寫入失敗也不丟資料 |

#### 10.2.1 為什麼選 `volatile-lru`

- 所有 key 都有 TTL(§5 規則),`volatile-lru` 等效於 `allkeys-lru` 但語義更明確
- 真正不希望被 evict 的 tier(auth / job),仰賴 §5.1 「不可 evict」這個**應用層規則**;Redis 層面不額外做物理隔離(避免拆 logical DB 增加複雜度)
- 若日後 auth tier 流量增大、與 cache 競爭記憶體,改用「兩個 Redis instance」分離,而**不是**靠 eviction policy

### 10.3 規則

- prod 啟動腳本 / 部署設定**必須**檢查 AOF 開啟,否則拒絕啟動(由 `/health/cache` 確認)
- maxmemory 上限由部署配置,**至少預留 30% headroom**;超過 90% 觸發告警(metric 由未來 spec)

---

## 11. 連線錯誤、重連、降級

### 11.1 重連策略

ioredis 預設 `retryStrategy: (times) => Math.min(times * 200, 2000)`(指數退避到 2s 封頂)。本專案保留預設,額外限制:

- **`maxRetriesPerRequest: 3`**:單一 command 最多重試 3 次,失敗即拋 `MaxRetriesPerRequestError`
- **`enableReadyCheck: true`**:等 Redis `INFO` 報 ready 才送 command(避免 loading 中送請求)
- **`reconnectOnError`**:預設關閉;若 prod 出現特定 READONLY error(failover 場景)再啟

### 11.2 錯誤映射(呼應 spec 005)

| Redis 失敗 | 對應 AppError | HTTP |
|---|---|---|
| 連線失敗 / `MaxRetriesPerRequestError` | `ServiceUnavailableError` (`code: 'CACHE_UNAVAILABLE'`) | 503 |
| Lua / 命令參數錯誤(WRONGTYPE 等) | `InternalError`(programmer error) | 500 |
| Timeout | `ServiceUnavailableError` (`code: 'CACHE_TIMEOUT'`) | 503 |

集中於 `src/lib/cache/errors.ts:mapRedisError`,errorHandler 不為 Redis 寫 if-else。

### 11.3 降級政策

| Tier | Redis 不可用時的行為 |
|---|---|
| Cache | **降級**:略過 cache,直接打 SoT;route 仍正常回應,僅效能下降 |
| Auth state | **失敗**:拋 503;絕不繞過 token 驗證 |
| Rate-limit | **失敗開放 OR 失敗關閉**:本專案選**失敗關閉**(503),避免 abuse;若 rate-limit 是面向匿名流量可改失敗開放 |
| Lock | **失敗**:拋 503;鎖無法取得 = 不執行受保護操作 |
| Job | **失敗**:寫入失敗回 503 |

### 11.4 規則

- 降級邏輯**封裝在 `src/lib/cache` 內**,業務代碼不感知
- 降級時**必須** log `event: 'cache_degraded'`,便於告警
- 重連成功後 log `event: 'cache_recovered'`,並重置降級狀態

---

## 12. 安全

### 12.1 認證

- **dev / stage / prod 一律啟用 Redis AUTH**(Redis 6+ ACL,專用 user;不用 `default` user)
- AUTH 密碼隨 connection string(`redis://:password@host`)或 ACL 提供
- 密碼屬 secret(spec 001 §5),由 secret manager 注入

### 12.2 TLS

- **prod / stage 必走 TLS**(`rediss://` scheme 或 ioredis `tls` 選項)
- dev 可不開,但本機若連雲端 Redis 則須開
- 自簽憑證需在 `tls.ca` 指定;不允許 `rejectUnauthorized: false`

### 12.3 網路

- prod Redis 必須在**私有網段**,不暴露 public IP
- Redis 預設 `bind 0.0.0.0` 危險;在容器 / 雲端服務中由 network policy 限制

### 12.4 危險命令

- 在 prod ACL 中**禁用** `FLUSHDB` / `FLUSHALL` / `CONFIG` / `DEBUG` / `KEYS`(用 SCAN 取代)
- dev 不禁用,但 backend 程式碼**禁止呼叫** `FLUSHDB`(只測試 setup / teardown 可用)

---

## 13. 觀測性

### 13.1 與 Logger(spec 004)整合

- ioredis 事件全部接到 child logger `module: 'cache'`
- 連線事件對應 spec 004 §9.3 字典:`cache_connected` / `cache_disconnected` / `cache_reconnecting` / `cache_error`
- 操作層**不**每筆 log(會淹掉 log);只在 error 或 degrade 時 log

### 13.2 Slow log

- 設 `slowlog-log-slower-than 10000`(10ms,單位 microseconds);門檻可隨流量調整
- 啟動時 dump slowlog 並 reset(便於回查上次未處理的 slow)— 由未來 ops spec 處理

### 13.3 Metrics(預留)

- `cache_hit_total{purpose}`、`cache_miss_total{purpose}`、`cache_latency_seconds{cmd}`
- 由 OpenTelemetry / Prometheus exporter 提供,**留待 metrics spec**

### 13.4 健康檢查

- `GET /health` 不查 Redis(避免雪崩)
- `GET /health/cache` 做 `PING`;**額外**驗證 AOF 開啟(prod):`CONFIG GET appendonly`(若 ACL 禁用 CONFIG,改由部署平台檢查)

---

## 14. 測試

呼應 backend `CLAUDE.md`:**不 mock Redis**,用 `testcontainers` 起真實 Redis。

### 14.1 啟動

- integration / e2e suite 共用一個 Redis container,suite-level setup
- ioredis 連到 container 提供的 host:port
- container 啟動 ~1-3s,可接受

### 14.2 隔離

- **每個 test 前 `FLUSHDB`**(快、簡單;dev 環境的 backend 不可呼叫此命令,測試 helper 例外)
- 或用獨立 logical DB(`SELECT N`)按測試分組;預設用 FLUSHDB

### 14.3 規則

- 測試**禁止**直接讀寫 prod-style key(用 isolated test prefix `jkod-test:`)避免後續 dev 環境意外殘留
- 測試對「降級」行為驗證:可用 container `pause` 模擬 Redis 故障,斷言 cache tier 走 SoT、auth tier 503

---

## 15. 與其他模組整合

### 15.1 與 ADR 004(Token strategy)

- refresh token / blacklist 走 `auth` tier(§5),`AOF` 必開、不可 evict
- key 設計呼應 ADR 004 §「Redis Key 設計」:`jkod:auth:refresh:{tokenId}`、`jkod:auth:refresh:user:{userId}`、`jkod:auth:blacklist:{jti}`
- token 寫入/撤銷邏輯**封裝於 `src/lib/auth/tokens.ts`**,不直接散落各 route

### 15.2 與 Errors(spec 005)

- 所有 Redis 錯誤經 `mapRedisError` 轉成 `AppError`
- errorHandler 不重複處理 Redis 細節

### 15.3 與 Logger(spec 004)

- 連線事件、降級、reconnect 走 child logger
- 操作層**不**逐筆 log(只在 fail 時)

### 15.4 與 Prisma(spec 003)

- Redis 與 Prisma 是兩條獨立連線,**禁止**在交易內(`$transaction`)做 Redis 操作(會卡 DB 連線、且 Redis 失敗無法 rollback DB 已交付的部分)
- 「更新 DB + 失效 cache」的順序:**先 DB commit,再 Redis DEL**;Redis 失敗時 cache 短暫 stale,可接受(下個 TTL 自然清)

---

## 16. 公開 API(草案)

`src/lib/cache/index.ts` 對外只 export 受規約包裝的 helper,業務不直接拿 raw client:

```ts
// 通用 cache(自帶 namespace + TTL 強制)
export interface CacheTierApi {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T, ttlSec: number): Promise<void>
  del(key: string): Promise<void>
  // wrap 模式(自動 cache-aside)
  remember<T>(key: string, ttlSec: number, loader: () => Promise<T>): Promise<T>
}

// 鎖
export interface LockApi {
  acquire(name: string, ttlSec?: number): Promise<{ release: () => Promise<void> } | null>
}

// rate-limit
export interface RateLimitApi {
  hit(key: string, windowSec: number, limit: number): Promise<{ remaining: number; resetAt: number }>
}
```

`auth` / `job` tier 不暴露通用 API,由各模組(`src/lib/auth/tokens.ts` 等)自行使用 raw `fastify.redis`(因 key 命名與生命週期較特殊)。

---

## 17. 開放問題

- **Redis Cluster / Sentinel**:本專案單節點起步;若 prod 規模 / 可用性要求上升再評估,key 命名已預留 hashtag 空間(`{}` 可包關鍵段以路由到同一 slot)
- **Pub/Sub 是否引入**:目前無使用情境;若做即時通知再開新 spec
- **Stream(消息佇列)取代 List**:若有背景工作需求,Stream 比 List 更適合
- **跨 region 同步**:目前單 region;若擴展,需評估 active-active vs active-passive
- **Tier 強制執行**:目前靠 PR review,未來可加 lint(掃 source 中 `redis.set` 等 raw 呼叫,要求過 `cache` helper)
- **熱 key 偵測**:Redis `--hotkeys` 工具僅在 `lfu` policy 下;若改用 LFU 需重新評估

---

## 18. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-13 | 初版 |
