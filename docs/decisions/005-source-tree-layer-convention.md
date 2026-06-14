# 決策:`src/` 程式碼分層採 `lib / domain / routes / schemas` 四層

日期:2026-06-14

## 背景

ADR 003 已經定錨「business route → `src/routes/`,infra plugin → `src/lib/*/plugin.ts`」雙軌制,解決了**route 註冊位置**這個層面的疑問。

但是隨著 spec 018(S3 storage)落地,出現了新的分層問題:

1. presign endpoint 的「entity 存在檢查」(`ensureEntityExists`)是業務規則,**不是 infra**——既不屬於 `lib/s3/`(那層只懂 S3 不懂 charity),也不該塞進 `routes/v1/donation/uploads/presign.ts`(route handler 該保持薄)。我為它新建了 `src/domain/uploads/check-entity.ts`。
2. TypeBox schemas 從 spec 018 開始集中放在 `src/schemas/uploads/presign.ts`(過去 spec 008 的 schemas 是內嵌在 route 檔案中)。

`src/` 因此多了兩個目錄(`domain/`、`schemas/`),但**沒有任何文件**說明:

- `domain/` 跟 `lib/` 怎麼分?(`lib/auth/` 不是也是業務嗎?)
- 一個業務規則該放 `lib/<concern>/`、`domain/<concern>/` 還是 `routes/`?
- TypeBox schema 該內嵌 route 還是抽到 `schemas/`?

如果不定錨,spec 015 / 016 / 017 落地時三個 domain entity(Charity、DonationProject、SaleItem)會出現三種放法。本 ADR 定義 4 層分工與依賴方向。

## 選項評估

| 選項 | 描述 | 利 | 弊 |
|---|---|---|---|
| **`lib / domain / routes / schemas` 四層**(採用) | infra → `lib/`、業務規則 → `domain/`、HTTP handler → `routes/`、wire 型別 → `schemas/`;依賴方向單向 `routes → schemas + domain → lib` | 邊界清晰;單測友善(domain 不依賴 Fastify);schemas 集中讓 OpenAPI 產生器簡單;符合 hexagonal / clean architecture 直覺 | 4 個 top-level dir 比 2 個多認知成本;對小 feature 過度;`schemas/` 跟 route 分開遇到 schema 改動要追兩處 |
| 維持「business → routes、infra → lib」雙層(ADR 003 原狀) | 業務規則塞 `lib/<concern>/service.ts`、schemas 內嵌 route | 層數少;改 schema 直接改 route 檔案 | `lib/` 名實不符(明明是 business 也叫 lib);多 entry point 共用同一段業務時 service 沒地方放;OpenAPI 抽取困難 |
| NestJS 風格 `modules/<feature>/{controller,service,dto}` | 每個 feature 一個 module 目錄,內含 controller / service / dto 三件套 | 結構齊一;feature 一站式 | Fastify 沒 DI / decorator metadata;硬塞會丟掉 Fastify plugin pattern 優勢;ADR 003 已決定不走這條 |
| Onion / hexagonal 完整版(application + domain + infrastructure + interface 四層) | 加 application 層協調 domain 與 infra,domain 純函式 | 大型企業專案標準解;業務邏輯與 infra 完全可替換 | 本專案規模(< 10 entity)用不上;application 層空轉,多一層樣板 |

## 決策

採用 **`lib / domain / routes / schemas` 四層**:

```
src/
├── routes/                    ← presentation:HTTP handler
│   ├── auth/                       business endpoint(spec 007/008)
│   │   ├── google.ts
│   │   └── password.ts
│   └── v1/donation/uploads/
│       └── presign.ts              spec 018 §7
│
├── schemas/                   ← presentation:wire 型別(TypeBox)
│   └── uploads/
│       └── presign.ts              PresignQuerySchema / PresignResponseSchema
│
├── domain/                    ← business:純規則 + Prisma I/O,不知道 HTTP
│   └── uploads/
│       └── check-entity.ts         ensureEntityExists(entity, id)
│
├── lib/                       ← infrastructure:跨 feature 基礎建設
│   ├── auth/                       JWT verify + login lock(*跨 feature*)
│   ├── auth-google/                OAuth 流程
│   ├── errors/                     setErrorHandler / RFC 7807
│   ├── health/                     readiness gate + 所有 /health/* 路由
│   ├── http/                       reply.ok() / .paginated() decorator
│   ├── logger/                     pino + child logger 工廠
│   ├── prisma/                     PrismaClient lifecycle
│   ├── rate-limit/                 sliding window
│   ├── redis/                      ioredis lifecycle
│   ├── s3/                         S3Client + presign + key/url helpers
│   └── security/                   helmet + cors
│
├── config/                    ← 啟動期 env 解析(spec 001)
│
├── app.ts                     ← Fastify 組裝(plugin 註冊順序)
└── server.ts                  ← Node entry(SIGTERM 串接 readinessGate)
```

### 各層的職責邊界與判別準則

#### `lib/` — Infrastructure(跨 feature 基礎建設)

- 跨多個 feature 使用,**不知道任何 entity 的業務語意**
- 例:`lib/s3/` 只懂 bucket / key / URL,不懂 charity 是什麼
- 例外:`lib/auth/` 是 cross-cutting business(每個 API 都要驗 token),放在 `lib/` 是因為它**跨整個服務**,不是某個 feature 的內部規則
- 大多數模組會匯出一個 Fastify plugin(`*Plugin`),由 `app.ts` 註冊

#### `domain/` — Business rules(feature 內部規則 + Prisma I/O)

- 一個 feature 內部的業務規則,**不知道 HTTP / Fastify**
- 可以 import `lib/`(infra 服務)與 `@prisma/client`(資料層)
- 例:`domain/uploads/check-entity.ts` — entity 存在性檢查(presign 業務規則)
- **判別**:這段邏輯是否「**需要驗證業務不變式**」?是 → `domain/`;只是「**呼叫 SDK 把資料搬過去**」?是 → `lib/`

#### `routes/` — HTTP handler(presentation)

- 薄 — 解 query / body、呼 domain function、回 reply
- **不放業務邏輯**;route handler 內出現 if/else 業務分支就該抽到 `domain/`
- 路由路徑反映 URL 結構(`routes/v1/donation/uploads/` ↔ `/v1/donation/uploads/...`)

#### `schemas/` — Wire types(TypeBox)

- 跨 route 共用、外部會引用的 schemas(例:OpenAPI 生成、frontend 共用)放 `schemas/<topic>/`
- 單一 route 的小 schema(< 20 行)可以**內嵌在 route 檔案**,不必抽
- **判別**:這個 schema 是 contract(spec 寫進去的)還是內部?contract → `schemas/`

### 依賴方向(單向,不准回頭)

```
routes  →  schemas      (route import wire types)
routes  →  domain       (route 呼叫業務 function)
domain  →  lib          (domain 用 infra 服務)
schemas →  lib(限 type) (schemas 可 import lib 的 type union,如 lib/s3 的 ENTITIES)

禁:  lib →  domain  (infra 不該知道任何 entity)
禁:  lib →  routes   (infra 不該知道 HTTP 路徑)
禁:  domain →  routes(business 不該知道 HTTP)
禁:  schemas →  domain(wire 型別不該觸碰業務)
```

跨層 import 時若違反這幾條,就是分層出問題的訊號。

## 理由

### 1. `domain/` 必須跟 `lib/` 分開

`lib/` 內所有模組共通的特質是「**換掉 entity 還能用**」:S3 模組換成 Charity entity 還是同一支 S3 client、同一個 `buildKey` 函式;Redis 模組不關心存的是 session 還是 rate-limit 計數。

`domain/` 內的程式碼**只能用在特定 entity 上**:`ensureEntityExists(entity, id)` 只對 `'charities' | 'donation-projects' | 'sale-items'` 有意義。混進 `lib/s3/` 等於宣告「S3 模組懂 charity 是什麼」,這是錯的耦合方向(spec 018 §6 就是要保持 S3 module 領域純淨)。

### 2. `lib/auth/` 的存在不違反原則

`lib/auth/` 看起來像 business(管 account 登入),但它是 cross-cutting:**每個 business endpoint 都要過 auth middleware**。把它放在 `domain/` 反而會讓所有 feature 都得 import `domain/auth/`,沒比較好。

判別點:「這個 module **是否被服務裡 80% 以上的 route 使用**」。是 → cross-cutting → `lib/`;否 → feature-specific → `domain/`。

### 3. `schemas/` 集中的時機是 spec 落地時

當一個 spec 把 wire format 當作 contract(spec 016 / 017 / 018 都有 JSON 範例),那個 schema 就屬於外部 contract,**該集中**。內嵌 route 雖然方便修改,但 spec 改 → schema 改 → 多個 route 同步改的時候會漏。

例外:auth password (spec 008) 的 schema 內嵌在 `routes/auth/password.ts`,因為它早於本 ADR、且 schema 跟 route 1:1 對應。**不溯及既往**,新功能新規矩。

### 4. 為什麼不用 NestJS modules pattern

Fastify 的設計哲學是 plugin encapsulation(ADR 003 §1 已詳述),硬套 NestJS 的 controller/service/dto 三件套會:

- 把 Fastify plugin 抽象掉(失去 encapsulation 邊界)
- 變相要求 DI container(Fastify 沒有,要引入大型套件)
- 結構樣板化但內聚度反而下降(controller 跟 service 同一檔案才是內聚的)

我們選的 4 層是 NestJS modules pattern 的**最小子集**:把 NestJS 的 controller 改成 Fastify route handler,service 改成 domain function(純函式 / 純 Prisma 呼叫,不用 class),dto 改成 TypeBox schemas。

### 5. 對 spec 015 / 016 / 017 的指引

spec 015(donation domain data model)落地時,domain 邏輯(例:「DonationProject 達成目標金額時的計算」)該放 `domain/donation/`,**不是** `lib/donation/`。Charity list / detail 的查詢邏輯(spec 016 / 017)也是 `domain/charities/`。

`lib/donation/` 這個目錄**不應該存在**,因為 donation 是 feature,不是 infra。如果未來有需要,該細分到具體 entity 或 use case。

## 後果

### 正面

- 新人 / AI agent 探索專案時有明確路徑可循:「找業務規則去 `domain/`,找 infra 去 `lib/`,找 HTTP entry 去 `routes/`」
- domain 層純函式 / 純 Prisma 呼叫,**可獨立 unit test 不用起 Fastify**
- schemas 集中讓 OpenAPI 生成器(spec 005 / 009 後續)可以 walk 一個目錄拿全部 contract
- spec 015 / 016 / 017 落地時三人各寫一個 feature,放置位置不會分歧

### 負面

- 從 ADR 003 的 2 層變 4 層,小 feature(只一個 route 一個 query)會覺得樣板多。**接受**:大部分新 feature 不會這麼小;真的有小到不值得 4 層的,允許 schemas 內嵌 route 並標明「too small for `schemas/`」
- 既有 `lib/auth/service.ts` 形式不動,**不溯及既往**重構為 `domain/auth/`。理由:auth 是 cross-cutting,服務 80% 以上的 route,留在 `lib/` 符合本 ADR 的判別準則
- `schemas/` 跟 route 分檔,改 schema 要 grep 找 caller。**接受**:tsc 會抓所有 type 不符,沒有靜默 drift 風險

### 中性

- 本 ADR 不規範 `domain/` 內部目錄結構(例:`domain/uploads/` 是按 use case、`domain/charities/` 是按 entity)。讓 PR 作者選最自然的切法,等出現 2 種以上不一致時再寫補充 ADR

## 相關文件

- ADR 003 — HTTP route 註冊位置(本 ADR 是它的延伸:再分 `routes` 內部的 domain / schemas)
- spec 018 §3 — 模組結構(`lib/s3/` 是 `lib/` 範例)
- spec 018 §7.4.1 — `ensureEntityExists` 是 `domain/` 範例
- spec 018 §7.1 — `PresignQuerySchema` 是 `schemas/` 範例
- 既有 `routes/auth/password.ts` — schema 內嵌 route 的「不溯及既往」範例
