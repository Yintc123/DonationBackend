# 決策:HTTP route 註冊位置採「business → `src/routes/`、infra plugin → `src/lib/`」雙軌

日期:2026-06-14

## 背景

接觸過 Express / NestJS / Koa / Next.js 的開發者,直覺會以為「所有 HTTP route 都集中在 `src/routes/`」。但本專案的 `src/routes/` 只有 `auth/` 一個目錄,而健康檢查的三個 route(`GET /health/{live,ready,startup}`)卻是註冊在 `src/lib/health/plugin.ts` 內——這違反了上述直覺。

在實際開發中遇到的具體疑問:

> 「`/health/ready` 是 backend 提供的 endpoint,為什麼 grep `src/routes/` 找不到任何相關檔案?」

這個落差**反覆出現**(自己回頭看會問、新人加入會問、AI agent 探索專案結構時也會問),因此值得明文記錄慣例與理由。同時這也是 Fastify 與其他框架最大的設計分歧點之一,值得在 backend 首份「程式碼組織」ADR 內定錨。

## 選項評估

| 選項 | 描述 | 利 | 弊 |
|---|---|---|---|
| **business → `src/routes/`、infra plugin → `src/lib/*/plugin.ts`**(採用) | `/api/*` 等使用者導向 endpoint 集中在 `routes/`;health / cors / rate-limit 等橫切關注 plugin 與其註冊的 route 一起放在 `lib/<concern>/` | 內聚高(plugin 邏輯 + route handler + state + test 同層);使用 Fastify encapsulation 隔離 scope;符合官方文件「Plugin Driven」哲學;business / infra 兩層意圖清楚 | 「找 endpoint 不能只看 `routes/`」需要慣例文件記錄(本檔即為此而生) |
| 全部 route 集中在 `src/routes/` | 把 `app.get('/health/live')` 等也搬到 `src/routes/health.ts` | 符合 Express / NestJS 直覺,grep `routes/` 就能列全部 endpoint | health route handler 需要的 `readinessGate` / `memoizeProbe` / probe timeout 常數會散落兩處(plugin 在 lib、route 在 routes),破壞內聚;違反 spec 011 §9 把 SIGTERM 串接 gate 的設計;偏離 Fastify 慣例,後續引入新 plugin 都要兩處對齊 |
| 全部 route 按 domain 都放 `src/lib/` | 連 `auth/` business 也搬到 `src/lib/auth/plugin.ts` 註冊 route | 全專案結構一致 | 「lib」字面意義是「可重用模組」,塞 business 進去會讓 lib 與 domain 邊界糊掉;後續抽取共用套件(`@jko/lib-*`)時無法切乾淨 |
| 採 NestJS 風格 Module 目錄 | `src/modules/health/`、`src/modules/auth/`,內含 controller / service / module 三件套 | 結構標準化、IDE 工具支援好 | Fastify 沒有 Nest 的 DI / decorator 體系,硬套會把框架優勢丟失;本專案已採 Fastify plugin pattern,改動成本大且收益小 |

## 決策

採用**雙軌制**:

```
src/
├── routes/              ← business endpoint(/api/*、使用者導向)
│   └── auth/
│       ├── login.ts
│       └── ...
└── lib/                 ← infra concern(横切關注 + 各自的 route)
    ├── auth/            (JWT verify decorator)
    ├── auth-google/     (OAuth callback 處理)
    ├── errors/          (setErrorHandler)
    ├── health/          ← 註冊 /health/{live,ready,startup} 在此
    ├── http/            (reply decorators)
    ├── logger/          (pino + child logger 工廠)
    ├── prisma/          (PrismaClient lifecycle)
    ├── rate-limit/      (sliding window + preHandler)
    ├── redis/           (ioredis lifecycle)
    └── security/        (helmet + cors)
```

判別準則:**該 route 的存在理由,是「業務需求」還是「infra 橫切」?**

- 業務需求(會出現在 PRD / Figma / 規格書) → `src/routes/`
- infra 橫切(K8s probe、CORS 預檢、rate-limit headers 等運維需求) → `src/lib/<concern>/plugin.ts`

## 理由

### 1. Fastify 的設計哲學是 plugin-driven

Fastify [官方文件 *Plugins Guide*](https://fastify.dev/docs/latest/Reference/Plugins/) 的標題就是 “Encapsulation”——plugin 不是個檔案組織策略,是**執行期的隔離邊界**:

- 每個 plugin 有自己的 scope(decorators / hooks / 子 route 不洩漏到父層)
- 透過 `fastify-plugin` 可顯式 opt-out 封裝,讓 decorator 提升到父 scope
- Plugin 之間用「`onReady` / `decorate` / `addHook`」串資料,不是傳統 import

這套機制讓「健康檢查」這種橫切關注可以**自包含**:`plugin.ts` 內同時持有 readiness gate 狀態、SIGTERM listener、probe 函式、cache 邏輯、route handler、event logger——全部在一個檔案。route 只是「對外開窗」,真正的邏輯在 plugin 內。

把 route 拆出去到 `src/routes/health.ts`,handler 就要透過跨檔案 import 拉 gate 狀態,Fastify scope 隔離也就失效。

### 2. 內聚性高於結構一致性

`src/lib/health/` 目錄打開包含:

```
plugin.ts       ← route 註冊 + handler
gate.ts         ← readiness gate state machine
probes.ts       ← PG / Redis 探針 + 聚合邏輯
gate.test.ts    ← gate 單元測試
index.ts        ← 對外只 export healthPlugin
```

把 route 搬走 = 把 plugin.ts 拆兩半,跨資料夾關聯。spec 011 §3 / §9 描述的「gate 由 plugin 管理、SIGTERM 由 server 觸發、probe 在 plugin 內 memoize」這條設計鏈會被結構性切斷。

`src/routes/` 留給「Charity 列表」、「捐款專案詳情」這類**獨立**的 business endpoint——它們不持有跨 request 的狀態、不串 Fastify lifecycle,只是「拿請求 → 查 DB → 回應」,本來就適合扁平擺。

### 3. 找 endpoint 的權威指令

承認本決策的代價是「不能直接 grep `src/routes/`」,所以正規查 endpoint 的方式改為:

```bash
# 列出所有註冊的 route(權威清單)
grep -rE "app\.(get|post|put|delete|patch|all)\(" src/

# 或啟動後 fastify 內建:
# app.printRoutes() — 印 routing tree
```

任何 route 註冊都會被上方 grep 抓到,不論在 `routes/` 還是 `lib/<concern>/plugin.ts`。

### 4. 與其他 spec 的對齊

- spec 011(健康檢查):正文即假設 plugin 自帶 route。本 ADR 不改 spec 011,只是補上組織層級的解釋
- spec 014(部署 / Container):container `healthCheck` / ALB target group 指向 `/health/*`,實作位置不影響部署面
- 後續 spec(charity 列表、捐款 API):依本 ADR 進 `src/routes/`,不再個案討論

## 後續

- 新增 endpoint 時依「業務 vs infra」二擇:有疑慮先問,不要把 business endpoint 註冊在 lib/ 內鬆動慣例
- `backend/docs/README.md` 索引維持依 spec 編號排序,本 ADR 不額外進入結構圖(已是純規範性決策,非執行流程)
- 之後若 endpoint 數量爆炸到 `src/routes/` 需要再分層(by domain / by access level),另開 ADR 討論,不在本檔擴張

## 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-14 | 初版;定錨「business → routes/、infra plugin → lib/」雙軌制 |
