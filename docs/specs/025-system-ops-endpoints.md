## Spec 025:System Operations Endpoints(維運 / 應急用 admin API)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.1 |
| 日期 | 2026-06-16 |
| 適用範圍 | `backend/src/routes/cms/system/*`(新)|
| 相關 ADR | 待補 |
| 相關 spec | 006(Redis plugin)、010(Rate-limit)、019(Cache policy)、023(API routing & versioning)、024(CUD surface invariant) |

---

## 1. 目的與範圍

### 1.1 目的

提供**維運 / 應急用的 admin endpoint** 群。第一個落地的是 `POST /cms/system/flush-redis`(全清 Redis),用於:

- Cache poisoning 緊急應變(整批 cache 寫壞了,需要強制 invalidate)
- Rate-limit policy 改動後重置 counter
- 開發 / staging 環境快速清狀態

未來可能進到 `/cms/system/*` 的同類 endpoint:
- `POST /cms/system/cache/invalidate-tag`(細顆粒 cache 清理)
- `POST /cms/system/db/reconnect`(強制 DB pool 重連)
- `POST /cms/system/audit/replay`(從 log 重播 audit)

本期只規範 `flush-redis`,其餘留未來補 spec。

### 1.2 In scope

- `/cms/system/*` surface 歸屬規約(對齊 spec 024 §2.1 invariant)
- `POST /cms/system/flush-redis` 完整規格(body、response、audit、rate-limit、風險警告)
- 安全機制(double-check confirm 字串)

### 1.3 Out of scope

- 細顆粒 cache invalidation(`flush-redis` 是大刀,細顆粒走 spec 019 / 既有寫入 endpoint 的 hook)
- 非 admin 的「我的 session 登出全裝置」(spec 008 §6 自助範圍,不算 ops)
- production 的 Redis 容量 / persistence 設定(infra 範疇)

---

## 2. Surface 歸屬

`/cms/system/*` — 對齊 spec 024 §2.1 invariant:**所有需 admin 權限的寫入,一律走 `/cms`**。雖然 Redis 不是 entity,但 `FLUSHDB` 是「需要 admin 權限的破壞性寫入」,落 `/cms`。

`system` sub-prefix 把「ops / 維運」endpoint 從「entity 管理」(`/cms/donation/*`、`/cms/orders/*`)區隔開來,讓 routerPath 過濾在 log / metric 一眼看出哪個是業務操作、哪個是 ops。

```
/cms/donation/*     ← entity CUD(spec 020 / 024)
/cms/orders/*        ← Order admin(spec 022)
/cms/uploads/*       ← S3 presign(spec 018)
/cms/system/*        ← ops / 維運(本 spec)  ← NEW
```

---

## 3. Endpoints

### 3.1 `POST /cms/system/flush-redis`

**全清當前 Redis logical DB**。等同 Redis `FLUSHDB` 指令。

```
Body(strict additionalProperties: false):
{
  "confirm": "FLUSH_ALL_REDIS_DATA"   ← literal,不對則 400 VALIDATION_FAILED
}

成功:
  → 200 + {
      "flushedKeyCount": number,   // FLUSHDB 前用 DBSIZE 取得
      "durationMs": number          // FLUSHDB 執行時間
    }
```

#### 3.1.1 行為

1. 從 `app.redis.dbsize()` 拿目前 key 數量(回傳一起給 ops 看「清了多少」)
2. 執行 `app.redis.flushdb()`
3. 量 `durationMs`
4. 發 audit event `system_redis_flushed`(warn 級)
5. 回 200 + body

#### 3.1.2 Auth & Rate-limit

| 維度 | 設定 |
|---|---|
| Auth | `/cms` scope-level `requireAdmin`(spec 023 §4.4)— role=0 |
| Rate-limit per-user | 6 / hour |
| Rate-limit per-IP | 12 / hour |

Rate-limit 故意設低,避免手抖 / script bug 連按。Ops 真要在 1 hour 內按 7 次,該被擋並提醒「為什麼?」。

#### 3.1.3 Audit event

```jsonc
// warn 級(破壞性);accountId 為觸發的 admin
{ "event": "system_redis_flushed",
  "accountId": "<admin uuid>",
  "flushedKeyCount": 123,
  "durationMs": 45,
  "reqId": "<uuid>",
  "audit": true }
```

#### 3.1.4 Error matrix

| 場景 | HTTP | Code |
|---|---|---|
| 未帶 token / token expired / disabled | 401 | `UNAUTHORIZED` |
| 非 admin role(role=1) | 403 | `FORBIDDEN` |
| body 未帶 `confirm` 或值不是 `"FLUSH_ALL_REDIS_DATA"` | 400 | `VALIDATION_FAILED`(TypeBox literal mismatch) |
| body 帶未宣告欄位 | 400 | `VALIDATION_FAILED`(`additionalProperties: false`) |
| Redis 連線中斷 / 異常 | 500 | `INTERNAL_ERROR`(global error handler) |
| Rate-limit 超 | 429 | `RATE_LIMIT_EXCEEDED` |

---

## 4. 風險警告(寫進 endpoint inline doc + spec)

### 4.1 副作用範圍

**`FLUSHDB` 清掉整個當前 Redis logical DB**,**不只**對齊 ioredis `keyPrefix`(本期是 `jkod:`)。意味著清掉的東西包含:

| Key 類型 | 影響 | spec |
|---|---|---|
| Cache(charity / project / sale-item list & detail JSON)| 冷啟動,DB 負載短期峰值 | 019 |
| **Rate-limit counter** | **所有 user / IP 配額瞬間回滿,短期 abuse 防線失效** | 010 |
| 未來的 idempotency key / session(若啟用)| 重複請求可能成功兩次 | — |

呼叫前要清楚知道**整個 logical DB 都清掉**,不是只清 cache。

### 4.2 多應用共用 Redis 的警告

若 production Redis instance 被**多個應用共用**(不同 `keyPrefix`),`FLUSHDB` 仍會清掉**所有應用**的資料,因為 ioredis `keyPrefix` 是 client-side 過濾,跟 server-side 的 `FLUSHDB` 無關。

→ **規約**:此 endpoint 假設 Redis instance 為本 backend 專用。共用部署前需先把這隻 endpoint 換成「SCAN + DEL by prefix」實作,或徹底下架。

### 4.3 為什麼不只清 cache prefix

實作上 `SCAN MATCH cache:* + DEL` 比 `FLUSHDB` 安全(只清 cache,保留 rate-limit),但兩個問題:
- 對 large keyspace `SCAN` 阻塞 redis 主執行緒可能(取決於 batch size + redis 版本)
- 跨類別清理需求(例如 rate-limit policy 改動後)還是需要 `FLUSHDB`,給 ops 兩個 endpoint 反而複雜

本期決策:**只給 `FLUSHDB`(全清)**,範圍清楚,風險明白。未來真的有「只清 cache」需求再加細顆粒 endpoint。

---

## 5. Test 策略

| Case | 期望 |
|---|---|
| 未登入 → 401 | `UNAUTHORIZED` |
| role=1(user)→ 403 | `FORBIDDEN` |
| admin + 正確 confirm → 200 | body 含 `flushedKeyCount` / `durationMs`;DBSIZE=0 |
| admin + 缺 `confirm` → 400 | `VALIDATION_FAILED` |
| admin + `confirm: "wrong"` → 400 | `VALIDATION_FAILED` |
| admin + body 帶未宣告欄位 → 400 | `VALIDATION_FAILED` |
| admin + 正確 confirm + Redis 預先有 key → 清空後 DBSIZE=0 | 真實 Redis(testcontainer)驗證 |
| Audit event 觸發 → log 含 `system_redis_flushed` / `accountId` / `flushedKeyCount` | **code review 確認**(本期不寫 logger spy assertion,跟 spec 022 既有 audit event 處理一致;若未來加 logger spy infra 統一補) |

合計 7 個 integration test(本期落地)。

---

## 6. Open questions

| # | 問題 | 暫定方向 |
|---|---|---|
| 1 | 是否需要環境 gate(production 禁用)? | **否**(本期):使用者選擇全 env 開放 + admin gate + confirm 字串雙重保護;production 風險由 ops 流程 + audit alert 管控 |
| 2 | 是否需要 audit alert webhook(PagerDuty 等) | 未來工作 — 本期僅 audit log,人類靠 log search 發現 |
| 3 | confirm 字串是否定期更換 | 不需要 — 固定字串便於文件化;真要防 typing-by-accident 已經有 confirm 機制 |
| 4 | 加細顆粒 cache invalidation endpoint(`/cms/system/cache/invalidate-tag`)? | 未來工作,看實際需求 |

---

## 7. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-16 | 初版 — `/cms/system/*` surface 歸屬規約 + `POST /cms/system/flush-redis`(全清 Redis logical DB)endpoint 完整規格;§4 風險警告(rate-limit 一併清掉、multi-app 共用 redis 注意);§5 test 策略(8 case)|
| 0.2 | 2026-06-16 | §3.1.2 雙層配額對齊實作:flush-redis route 顯式設 `perIp: { limit: 12, windowMs: 1h }`(原僅 purpose 6/h);純文件補強,實作見 `src/routes/cms/system/flush-redis.ts` |
