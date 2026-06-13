# CLAUDE.md — backend 專案級指示

本檔疊加於專案根目錄 `../CLAUDE.md`,僅約束 `backend/` 內的工作。

---

## 開發方式:TDD

### 鐵則

- **沒有失敗的測試就不寫產品碼**
- Red → Green → Refactor,順序不可顛倒
- 一次只專注一個失敗測試;不要為了「順便」加多個 case
- 修 bug 時:**先寫一個能重現 bug 的失敗測試**,再修

### TDD 例外(可不先寫測試)

- 型別宣告(`*.d.ts`、純 type alias / interface)
- 設定檔(`package.json`、`tsconfig.json`、`.env.example`)
- Fastify plugin 註冊單行(如 `app.register(cors)`)
- Prisma migration 腳本(由 schema 自動產出)
- 文件、註解、commit message

對於 logger 設定、env loader、middleware 註冊這類「**無邏輯但有副作用**」的邊界程式碼,**不寫 unit test**,改由 integration test 從外部行為驗證。

---

## 測試工具(預設選型)

| 用途 | 選擇 | 理由 |
|---|---|---|
| Test runner | `vitest` | 速度快(esbuild)、TS 原生、watch 順、API 接近 Jest |
| HTTP 測試 | `fastify.inject()` | 不起 port、純函式呼叫,unit / integration 通用 |
| DB 隔離 | `testcontainers` (PostgreSQL) | 與 prod 同型,呼應 ADR 002 的型別端到端原則 |
| Redis 隔離 | `testcontainers` (Redis) | 同上,避免 in-memory mock 與 prod 行為偏差 |
| 外部 HTTP | `msw` 或 `vi.fn()` stub | Google OAuth callback、第三方 webhook |

> 任何工具改動需更新本檔。

---

## 測試分層

| 層 | 範圍 | 目錄 | 期望速度 |
|---|---|---|---|
| unit | 純函式、domain logic、schema 驗證 | `src/**/*.test.ts`(與 source 同目錄) | < 50ms / test |
| integration | route handler + Prisma + Redis(真實 container) | `tests/integration/` | < 5s / test |
| e2e | 完整 HTTP flow,OAuth callback 用 stub | `tests/e2e/` | < 30s / test |

新增功能時,**至少寫 unit + integration 各一**;e2e 視關鍵路徑而定。

---

## Mocking 政策

- **不 mock Prisma / Redis** ——呼應 ADR 002,型別端到端是 Fastify 選型主因,mock 等於拋棄保障
- **可 mock 外部 HTTP**(Google OAuth、第三方 webhook):這些不在我們的控制邊界內
- **可 mock 時間 / 隨機**:`vi.useFakeTimers`、注入 clock / id 產生器,確保測試決定性
- 若覺得「真實 DB 太慢」,先檢討測試是否該降到 unit 層(用純函式拆分 domain logic),而不是改 mock

---

## 命名與檔案結構

- source 與 test 同檔名:`foo.ts` ↔ `foo.test.ts`
- `describe('functionName' | 'GET /path')` 對應被測單元
- `it('should X when Y')` 描述**行為**而非實作
- 測試敘述用英文(CI 輸出對齊、避免亂碼風險)

---

## 覆蓋率立場

- **不追求百分比門檻**——容易造成虛假覆蓋(寫無斷言的測試湊數)
- 重點:**關鍵路徑是否覆蓋**(auth flow、捐款流程、business invariant、錯誤分支)
- CI 印 coverage 報告供參考,但**不 fail build**

---

## Claude 在 backend 的行為要求

### 收到新增功能請求時

固定順序,逐步完成,不要跳步:

1. **寫測試**,跑一次,**確認紅**(列出錯誤訊息確認 fail 原因正確)
2. **寫最小產品碼**讓綠(避免「順便」實作未測試的分支)
3. **重構**並確認測試仍綠
4. 用 task tool 追蹤 red / green / refactor 各步驟

### 收到「先實作再補測試」的指示時

**主動提醒違反 TDD**,確認:

- 是否屬於上方「TDD 例外」清單?
- 若否,使用者是否明確同意這次破例?

不替使用者決定,不靜默跳過測試。

### 不確定該寫哪層測試時

先問,不猜。常見判斷:

- 純函式 → unit
- 牽涉 Fastify route、DB、Redis → integration
- 跨多個 route 的使用情境(登入 → 查詢資料) → e2e

---

## 例行檢查

- 開發中:`npm run test:watch` 保持開啟
- commit 前:`npm run typecheck && npm test` 全綠
- PR 前:`npm run test:integration`(或 CI 自動跑)

> 上述 script 待 vitest 安裝後補入 `package.json`。

---

## 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-13 | 初版 |
