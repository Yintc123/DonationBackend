# Spec 019:Public Read API 的 Redis Cache 策略

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.4 |
| 日期 | 2026-06-15 |
| 適用範圍 | `backend/src/lib/cache/`、`backend/src/services/cached-*/`(新)、`backend/src/routes/v1/donation/**/*.ts`(改) |
| 相關 ADR | `docs/decisions/011-cache-strategy.md`(adapter 層 + cache-aside + 熱門白名單 + TTL 表 + stampede 暫不啟用 + 失效 API 預留)|
| 相關 spec | `006-redis-module.md`(Redis 模組底層規約 — 本 spec 嚴格遵守 §4 key namespace、§6 TTL、§7 序列化、§9 cache-aside、§11 降級)、`016-charity-list-api.md` §8 / §11(原 list cache 規約)、`017-detail-apis.md` §2(原 detail cache 規約)、`015-charity-data-model.md`(資料形狀)|

---

## 1. 目的與範圍

> **URL prefix(spec 023 §2 已落地)**:本 spec 列的 endpoint path **不含 surface prefix**。實際 client URL 依 surface 加前綴:
> - Public read endpoints → `/user/v{N}/...`(spec 023 §2.2;當前 `v1`)
> - Admin write endpoints → `/cms/...`(spec 023 §2.3,scope-level `requireAdmin` 由 `/cms` plugin attach)
> - Auth endpoints → `/auth/...`(spec 023 §2.1,不版本化)
>
> Endpoint URL 完整 mapping 表見 spec 023 §2.4。

### 1.1 目的

對 backend 公開 read API 引入 Redis cache,在不破壞下列契約的前提下降低 PostgreSQL 負載與 P99 延遲:

1. spec 006 §9 cache-aside 預設模式
2. spec 016 / 017 既有 Cache-Control 與 ETag conditional GET 行為
3. spec 006 §11.3 降級政策:Redis 故障**不**得讓公開端點 5xx

### 1.2 In scope

- 哪些端點該 cache、哪些不該
- Cache 層在程式碼中的**位置**(三選一:route / domain / adapter)與決策
- Key schema、TTL、序列化、失效、降級、stampede 立場
- 測試與觀測規約

### 1.3 Out of scope

- 寫入端 API 的 cache 失效實作(目前無 admin 寫入路由;本 spec 只**保留** invalidation API)
- CDN / 瀏覽器 cache(由 `Cache-Control` header 處理,已在 spec 016 §8 / 017 §2 定)
- Stampede 防護的實作(本 spec **暫不啟用**,見 §10)
- Redis 連線、key namespace 底層、TTL 上下限 — 一律走 spec 006

---

## 2. 架構決策:Cache 層放在 adapter 層

### 2.1 三個選項

| 方案 | 描述 |
|---|---|
| A. Route handler 內 | handler 直接呼叫 redis,miss 再呼 domain |
| B. Domain service 內 | `listCategories` / `getDonationProjectById` 內部讀寫 redis |
| **C. 新 adapter 層**(採用) | 新增 `src/services/cached-*`,薄包裝既有 domain service;route 改呼 `cached-*` |

### 2.2 決策:選 C

**理由(對齊 CLAUDE.md「純函式 → unit;牽涉 Redis → integration」分層)**

- **A 不選**:7 個 GET handler 都會新增 ~20 行 cache 樣板;i18n + ETag header 已在 route,再疊 cache 邏輯讓 handler 失去單一職責
- **B 不選**:domain service 目前只依賴 `prisma + objectUrl + locale`,可純 unit test;塞 redis 後**所有** domain 測試強制升為 integration,測試金字塔倒置
- **C 採用**:
  - domain 純度不動 — 既有 unit test 全部保留
  - cache 規則集中於 `cached-*`,符合 spec 006 「分區治理」精神
  - route handler 只需把 `getDonationProjectById` 改成 `getCachedDonationProjectById`,diff 極小
  - 未來換 cache backend(in-memory / 不同 store)只動 adapter 一層

### 2.3 目錄結構

```
src/
  lib/
    cache/
      keys.ts              ← buildCacheKey('proj:detail:v1', segments[])
      keys.test.ts         ← unit
      with-cache.ts        ← 通用 cache-aside helper
      with-cache.test.ts   ← integration (testcontainers Redis)
      json.ts              ← 安全 JSON(處理 Date / null)
      json.test.ts         ← unit
      index.ts             ← public surface
  services/
    cached-category.ts     ← 包 listCategories
    cached-charity.ts      ← 包 listCharities / getCharityById
    cached-donation-project.ts
    cached-sale-item.ts
    *.integration.test.ts  ← tests/integration/ 對應
```

> `services/` 為新目錄;此 spec 落地時建立,與 `domain/` 並列。`domain/` 為純函式 SoT 邏輯,`services/` 為「跨基礎設施(redis / db / s3)的組合層」。

---

## 3. 適用範圍:該 / 不該 cache

### 3.1 該 cache(本 spec 落地)

| # | 端點 | 理由 |
|---|---|---|
| 1 | `GET /v1/donation/categories` | 16 列字典近不可變;locale 只有 2 個 key,命中率極高 |
| 2 | `GET /v1/donation/charities/:id` | 讀遠多於寫;key 維度單純 `id + locale` |
| 3 | `GET /v1/donation/donation-projects/:id` | 同上 |
| 4 | `GET /v1/donation/sale-items/:id` | 同上 |
| 5 | `GET /v1/donation/charities`(**僅熱門首頁**)| 流量集中於無 cursor 的首頁;其他組合 bypass |
| 6 | `GET /v1/donation/donation-projects`(**僅熱門首頁**)| 同上 |
| 7 | `GET /v1/donation/sale-items`(**僅熱門首頁**)| 同上 |

list 端點的「熱門首頁」定義(§4.2)。

### 3.2 不該 cache(永久 bypass)

| 端點 | 理由 |
|---|---|
| `GET /v1/donation/uploads/presign` | 簽名短期有效,cache 會固化過期 URL → 等同 bug |
| `GET /health/*` | 用途即時探活,cache 違反目的 |
| 任何 list 帶 cursor 的請求 | 翻頁是長尾流量,key 爆炸不利命中 |
| 任何 list 帶非白名單 filter 組合 | 同上 |

### 3.3 為何 list 不全 cache

list 完整 query 維度為 `cursor × pageSize × category × charityId × locale`,組合數呈指數成長,命中率低 → cache 反而消耗記憶體與寫入頻寬。先用白名單,後續若 metrics 顯示其他組合也有熱度,再個別新增。

---

## 4. Key Schema

### 4.1 一律走 spec 006 §4 `buildKey('cache', segments[])`

格式:`jkod:cache:<resource>:<sub>:v<n>:<segments...>`

| 端點 | Key 樣式 |
|---|---|
| categories | `cache:cat:list:v1:{locale}` |
| charity detail | `cache:char:detail:v1:{id}:{locale}` |
| project detail | `cache:proj:detail:v1:{id}:{locale}` |
| sale-item detail | `cache:sale:detail:v1:{id}:{locale}` |
| charity list(熱門)| `cache:char:list:v1:{categoryOrAll}:{locale}` |
| project list(熱門)| `cache:proj:list:v1:{categoryOrAll}:{charityIdOrAll}:{locale}` |
| sale-item list(熱門)| `cache:sale:list:v1:{categoryOrAll}:{charityIdOrAll}:{locale}` |

### 4.2 list「熱門首頁」白名單

落地 v1 採**保守**白名單(命中後可擴):

```
無 cursor + pageSize=預設 + category ∈ {ALL, 所有單一 category} + charityId=ALL
```

不符合白名單的請求**不進** cache(loader 直接呼 domain service)。

### 4.3 Schema 版本段 `:v{n}` 的用途

- response 形狀有 breaking change → bump v1 → v2,舊 key 自然 TTL 失效,**不需** SCAN / KEYS 清庫
- ETag 演算法變更 → 同樣 bump
- **嚴禁**用 SCAN MATCH 做 pattern delete(spec 006 §4.3 key segment 已禁 `*`,實作上 `KEYS` / `SCAN` 也禁用)

### 4.4 Locale 必入 key

i18n 兩語系若不分隔 key,zh / en 互蓋是必然事故。`{locale}` 一律放在 segments 最末,格式 `zh-TW` / `en`(spec 016 §4.1.1 字典)。

### 4.5 不存在的查詢不寫 sentinel

spec 006 §9.2 已禁「快取空結果作為不存在訊號」。`404 NOT_FOUND` 一律直接 throw → errorHandlerPlugin 處理,**不**進 cache。

---

## 5. TTL 政策

### 5.1 端點 TTL

| 端點 | TTL | 理由 |
|---|---|---|
| categories | **600s**(10 min) | 字典近不可變;spec 006 §6.1 cache tier 上限 1h,10 min 提供良好命中率同時管理員編輯後最壞延遲 10 min |
| 三個 detail | **60s** | spec 016 §11.1 標 time-sensitive(lifecycle filter);60s 內 `publishStart/End` 切換的視覺延遲可接受 |
| 三個 list(白名單) | **30s** | list 對 lifecycle 切換最敏感(品項可能從列表消失);更短 TTL 換更小延遲 |

### 5.2 TTL 規則(沿用 spec 006 §6.2)

- TTL 一律 `SET key value EX <seconds>` 同步設定,**禁** `SET → EXPIRE` 兩步
- TTL 不可為 0 / 負(spec 006 §6.2)
- 未來若新增端點,TTL 上限 1h;超過視同改架構

---

## 6. Cache-aside 實作規約

### 6.1 通用 helper:`withCache<T>(opts)`

`src/lib/cache/with-cache.ts`:

```ts
export interface CacheOptions<T> {
  redis: Redis
  key: string
  ttlSec: number
  logger: FastifyBaseLogger
  loader: () => Promise<T>             // SoT 查詢
  serialize?: (v: T) => string         // 預設 stableStringify
  deserialize?: (s: string) => T       // 預設 parseJson<T>
}

export async function withCache<T>(opts: CacheOptions<T>): Promise<T>
```

行為(嚴格對齊 spec 006 §9.1 + §11.3):

1. `GET key`
   - 命中 → `deserialize` → return
   - GET 拋錯 → log `cache_get_failed` (warn) → 降級走 loader
2. miss / 降級 → `await loader()`
3. `SET key value EX ttlSec`
   - SET 拋錯 → log `cache_set_failed` (warn) → 仍 return value
4. **不**在 helper 內處理 `NOT_FOUND` → loader 拋錯直接 propagate

### 6.2 cached-service 層樣板

```ts
// services/cached-donation-project.ts(示意)
export async function getCachedDonationProjectById(
  deps: { redis: Redis; logger: FastifyBaseLogger; ... },
  id: string,
): Promise<DetailResult> {
  return withCache({
    redis: deps.redis,
    key: buildCacheKey('proj:detail:v1', [id, deps.locale]),
    ttlSec: 60,
    logger: deps.logger,
    loader: () => getDonationProjectById(deps, id),
  })
}
```

### 6.3 Route handler 改動最小化

```diff
- const result = await getDonationProjectById({ prisma, ..., id })
+ const result = await getCachedDonationProjectById(
+   { redis: app.redis, prisma, ..., logger: req.log, id },
+ )
  return sendDetail(req, reply, locale, result)
```

ETag / Vary / Cache-Control 維持 route 層處理(已在 `headers.ts`),**不**搬到 service。

---

## 7. 序列化:ETag 與 body 同包

### 7.1 Cache value shape

把 domain service 的回傳整包當 value:

```ts
// detail
{ body: <full response>, etag: <strong etag> }
// categories
{ items: [...], etag: <strong etag> }
// list
<paginatedEnvelope result>  // 包含 items + nextCursor;list 無 ETag
```

### 7.2 為什麼 ETag 也 cache

route 層的 `sendDetail` / `sendCategories` 用 ETag 做 `If-None-Match` → 304 短路。把 ETag 一起 cache,讓 cache 命中時仍能 304 → 省下:

- DB query(已省)
- ETag 重算
- response body 序列化與傳輸

### 7.3 JSON 序列化(spec 006 §7.2)

- 預設 `JSON.stringify`,但**禁直接序列化 `Date` / `BigInt`**
- 提供 `src/lib/cache/json.ts`:
  - `stableStringify(v: unknown): string` — 用 replacer 將 `Date → ISO string`(走 `toJSON`)、`undefined → null`(對齊 spec 016 v0.13 「key 永遠存在」);`BigInt` 拋 `TypeError`(沿用 JSON.stringify 行為)
  - `parseJson<T>(s: string): T` — `JSON.parse` 的型別化包裝;ISO date string 不 reify 回 `Date`(domain 內已用 string;若日後需要 reify 再另立 helper)
- value 大小上限沿用 spec 006 §7.2:**100KB**;超過視同設計味道,review

### 7.4 不快取「不存在」

spec 006 §9.2 明禁。`getCharityById` 找不到 → throw `NOT_FOUND` → helper 不 SET,errorHandlerPlugin 回 404 + `Cache-Control: no-store`(已在 spec 017 §2 規範)。

---

## 8. 失效策略

### 8.1 現階段:TTL 兜底 + 寫入即時失效(v0.4 — 已實作)

> **v0.4 — 同步實作**:原文寫「純 TTL 兜底、僅預留 invalidation API」已過時。spec 020 admin 寫入路由落地後,失效**已完整實作**於 `src/lib/cache/invalidate-donation.ts`:每次 admin write(create / update / 4 個 lifecycle action)呼叫 `invalidateDonationEntity()`,由純函式 `donationCacheKeysFor()`(`invalidate-donation.ts:66-166`)**枚舉**該筆寫入影響的所有 cache key,再以單一 Redis pipeline `DEL`(無 SCAN,對齊 spec 006 §4.3)。枚舉來源即 §8.3 的 cascading 表(規約權威在 spec 020 §8.1)。失效失敗只 log warn 不 throw(spec 019 §9.1),cache 服務 stale 至 TTL。

TTL 仍是最終兜底:未接寫入路徑的 key(如 category 寫入對每筆 detail 的 cascade)靠 §5.1 的 TTL 自然過期。

### 8.2 helper 預留 invalidation API

```ts
// src/lib/cache/with-cache.ts
export async function invalidate(
  redis: Redis,
  key: string,
  logger: FastifyBaseLogger,
): Promise<void>
```

行為:
- `DEL key`;拋錯 → log warn,**不** throw(失效失敗不阻擋寫入路徑)
- **嚴禁** `SET 新值`(spec 006 §9.2)

### 8.3 admin 寫入接點(v0.4 — 已實作於 `invalidate-donation.ts`)

失效枚舉的實作權威在 spec 020 §8.1,由 `donationCacheKeysFor()`(`src/lib/cache/invalidate-donation.ts:66-166`)產出。形狀:

| 寫入操作 | 應失效的 key |
|---|---|
| Charity write（`/cms` create / update / lifecycle）| `cache:char:detail:v1:{id}:{zh-TW,en}`;所有 `cache:char:list:v1:{categoryOrAll}:{locale}`;以及 cascading 的 `cache:proj:list:v1:*` **與 `cache:sale:list:v1:*`**(scope 為 `{id, ALL}` × 每個 category × locale)—— v0.4 補上 sale list(`invalidate-donation.ts:86-93` charity 分支同時枚舉 proj + sale list,因 cascading visibility 讓 charity lifecycle 變動同時影響旗下 project **與** sale-item 的列表可見性) |
| Project write | `cache:proj:detail:v1:{id}:{zh-TW,en}`;以及 `cache:proj:list:v1:*`（scope `{parentCharityId, ALL}`）|
| SaleItem write | `cache:sale:detail:v1:{id}:{zh-TW,en}`;以及 `cache:sale:list:v1:*`（同上邏輯）|
| Category write | `cache:cat:list:v1:{zh-TW,en}`；每筆 detail 的 cascade 因量體過大留給 TTL（`invalidate-donation.ts:129-141`）|

> list cache 「所有 pattern」失效**不**用 SCAN / KEYS;改為**白名單枚舉 DEL**(因為 §4.2 白名單組合數固定),或直接 schema bump。

### 8.4 一致性立場

cache + DB 不可能達成強一致;本 spec 接受 **「TTL 末端 ≤ 10 min」eventual consistency**。對 detail / list 是 ≤ 60s / 30s,對 categories 是 ≤ 10 min。商業可接受性與 ADR 對齊(待補)。

---

## 9. 降級與容錯(對齊 spec 006 §11.3)

### 9.1 Redis 不可用時的行為

| 階段 | 行為 |
|---|---|
| 啟動連線失敗 | spec 006 §3.2 — fail-fast,backend 啟動失敗(已實作) |
| 執行期 `GET` 失敗 | log `cache_get_failed` warn → 走 loader → return |
| 執行期 `SET` 失敗 | log `cache_set_failed` warn → return loader 結果 |
| 執行期 `DEL` 失敗(未來)| log `cache_del_failed` warn → 不 throw |

### 9.2 嚴格不變式

- Cache 失敗**永遠**不可讓公開端點回 5xx
- Cache 失敗**永遠**不可改變 response shape
- Cache 失敗**永遠**不可改變 ETag / Cache-Control header

### 9.3 觀測

- `cache_get_failed` / `cache_set_failed` warn 含 `key`(不含 value)、`err.code`
- 命中 / miss 不記 log(避免熱路徑噪音);用 metrics 計數(§11)

---

## 10. Stampede:暫不啟用

spec 006 §9.3 列出三種防護(request coalescing / probabilistic early refresh / distributed lock)。本 spec **不**主動啟用,理由:

- 本作業流量規模未到 stampede 觸發門檻
- TTL 短(30s ~ 10min),最壞情況單 instance 短時間多次穿透,DB 可承受
- 過度設計違反 CLAUDE.md「don't design for hypothetical future requirements」

啟用觸發條件(未來 ADR 評估):

- 觀測到 DB QPS 在 TTL 邊界出現週期性尖峰
- 或單一 hot key 引發 P99 退化

---

## 11. 觀測

### 11.1 Metric(待 spec 觀測模組落地後實作)

| Metric | Tag | 用途 |
|---|---|---|
| `cache_hit_total` | `resource`, `op`(detail/list/dict) | 命中率 |
| `cache_miss_total` | 同上 | 命中率 |
| `cache_error_total` | 同上 + `phase`(get/set/del) | 降級頻率 |
| `cache_loader_duration_ms` | 同上 | miss 時 SoT query 耗時 |

### 11.2 Log

- 連線事件:已在 `redisPlugin`(spec 006 §13.1)
- 命中 / miss:**不**記 log(每請求一筆 = 流量噪音)
- 錯誤:§9.3

---

## 12. 測試

嚴格遵守 backend CLAUDE.md TDD 鐵則。

### 12.1 測試分層

| 層 | 範圍 | 工具 |
|---|---|---|
| unit | `buildCacheKey` 各種 segment / locale 組合 | vitest |
| unit | `stableStringify` 對 Date / undefined / null 的處理 | vitest |
| integration | `withCache` 完整 GET / SET 流程 | testcontainers Redis |
| integration | `withCache` Redis down 時降級 | testcontainers Redis(中途 stop) |
| integration | 各 cached-service 命中 / miss / TTL 過期 | testcontainers Redis + Postgres |
| e2e | route 層改動後 ETag / Cache-Control header 不退化 | fastify.inject() + testcontainers |

### 12.2 必須有的測試

| 測試 | 為什麼必要 |
|---|---|
| Redis down 時 detail endpoint 仍 200 | §9.2 不變式;否則 cache 變成新的 SPOF |
| ETag 在 cache miss / hit 兩條路徑值相同 | 否則 304 邏輯壞掉 |
| 304 short-circuit 在 cache hit 路徑仍生效 | §7.2 設計目的 |
| list 非白名單組合**不**進 redis | §3.3 設計目的;避免 key 爆炸 |
| 不存在的 id 不寫 sentinel | spec 006 §9.2 |

### 12.3 不 mock Redis / Prisma

對齊 CLAUDE.md Mocking 政策;testcontainers Redis + Postgres。

---

## 13. 落地順序(每步 red → green)

1. **本 spec merge** + ADR 011(cache-strategy)起草
2. `lib/cache/keys.ts` + unit test
3. `lib/cache/json.ts` + unit test
4. `lib/cache/with-cache.ts` + integration test(testcontainers)
5. `services/cached-category.ts` + integration test → route 切換 → e2e 驗 header 不退化
6. detail × 3 包裝 + 測試 → route 切換
7. list × 3 熱門白名單包裝 + 測試 → route 切換
8. 跑一週 metrics,評估是否擴白名單 / 啟用 stampede 防護

### 13.1 為什麼從 categories 起手

- 流量最集中、key 維度最簡(2 個 key)
- 失效情境最單純(目前無 admin 寫入)
- 一條完整的「lib + service + route + test」流程跑通後,detail / list 是純複製

---

## 14. 開放問題

| # | 問題 | 提案 |
|---|---|---|
| O1 | list 端點熱門組合是否要包含「分頁第 2 / 3 頁」? | v1 不;v2 觀測後決定 |
| O2 | Cache `paginatedEnvelope` 內含 `nextCursor`,cursor 是否隨 list 變化失效? | nextCursor 在 30s TTL 內可接受少量飄移;e2e 測試覆蓋 |
| O3 | 是否需要對 zh / en 之外的 Accept-Language 也 cache? | 否;spec 016 §4.1.1 已 fallback 為 zh-TW,key 維度不變 |
| O4 | adapter 層日後支援 in-memory cache(無 Redis 環境如 unit test)? | 暫不;測試一律走 testcontainers,違反 mocking 政策 |

---

## 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-15 | 初版 |
| 0.2 | 2026-06-15 | §7.3 — `parseWithDates` 改名 `parseJson`(名稱誤導,實際不 reify Date);與 `src/lib/cache/json.ts` 實作對齊;補上 `withCache` deserialize 預設值的名稱對齊 |
| 0.3 | 2026-06-16 | §1 加 spec 023 §2 URL prefix cross-ref(public read → `/user/v{N}`、admin write → `/cms`、auth → `/auth`);本 spec endpoint path 列為 surface 內相對路徑,實際 client URL 由 surface prefix 拼成。完整 URL mapping 表見 spec 023 §2.4。對應 backend code/test 已 cutover 至新結構 |
| 0.4 | 2026-07-07 | 與實作同步(不改 code):(1) §8.1 標題 / 內文更新 —— 原「純 TTL 兜底、僅預留 invalidation API」已過時,spec 020 寫入路由落地後失效已完整實作於 `src/lib/cache/invalidate-donation.ts`(`donationCacheKeysFor()` 枚舉 + pipeline `DEL`,無 SCAN),加 cross-ref;(2) §8.3 標題改「已實作」,Charity write cascading 補上 `cache:sale:list:v1:*`(`invalidate-donation.ts:86-93` charity 分支同時枚舉 proj + sale list,cascading visibility 同時影響旗下 project 與 sale-item 列表可見性)|
