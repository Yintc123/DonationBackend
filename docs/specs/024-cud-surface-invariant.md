# Spec 024:Entity CUD Surface Invariant(所有資源 CUD 一律走 `/cms`,Order 為交易流程例外)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.2 |
| 日期 | 2026-06-16 |
| 適用範圍 | 所有 backend HTTP endpoints 的 URL surface 分配規約(對 spec 023 的補強)|
| 相關 ADR | 待補 |
| 相關 spec | 023(API Routing Structure & Versioning)、015(Charity data model)、020(Donation write API)、021(Donation Order data model)、022(Donation Order API)|

---

## 1. 目的與範圍

### 1.1 目的

Spec 023 §2.3 把 `/cms` 定義為「後台管理 surface,scope-level `requireAdmin`」,但**沒有**規範「entity 的 CUD 操作是否一律必須走 `/cms`」這條 invariant。實際 code 雖然目前對齊(spec 020 §5 把 Charity / Project / Sale-Item / Category 的 CUD 全部放在 `/cms`),但若沒有明文 invariant,未來新增 entity 時容易意外把 CUD 分散到 `/user/v{N}`,造成:

- 使用者端被迫加 admin auth gate(spec 023 §2.2 規範使用者端不版本化身分檢查)
- 後台 UI 要橫跨多個 surface 才能管完一個 entity
- 規格 / code drift

本 spec 鎖死一條 invariant 並列出當前落地狀態與未來擴展路徑。

### 1.2 In scope

- 規範「entity CUD 一律走 `/cms`」的 invariant
- 規範 Order 為何例外(交易流程 vs 資源管理)
- 列已落地的 CUD endpoint 清單
- 規範新增 entity 時的 surface 分配決策樹
- 規範未來 user-side order update(spec 022 §11 OQ #2 的可能落地形狀)

### 1.3 Out of scope

- 三個 surface 本身的設計理由 → spec 023 §2
- 個別 endpoint 的 schema / body / response → 對應資源 spec(020 / 022)
- 認證細節 → spec 007 / 008 / 020 §2.3

---

## 2. 核心 Invariant

### 2.1 規約

> **所有 entity 的 Create / Update / Delete 操作必須在 `/cms` surface 下。**

「entity」定義:有 Prisma model + 後台管理介面 / 工作流會主動操作的資源。本期 entity:
- `Charity`
- `DonationProject`
- `SaleItem`
- `Category`
- `Account`(身分 entity,管理路徑特殊,§3.2)

「非 entity」(交易 / 流程 / 投影):
- `Order` / `OrderLine`(交易記錄,non-entity § 2.3)
- `PasswordCredential` / `GoogleCredential`(身分子結構,Account 的內嵌,不單獨管理)

「CUD」涵蓋的具體 HTTP 動詞:
| 動詞 | 對應 |
|---|---|
| **POST**(create) | `POST /cms/{resource}` |
| **PATCH**(update) | `PATCH /cms/{resource}/:id` |
| **DELETE**(soft delete) | `DELETE /cms/{resource}/:id` |
| **POST**(lifecycle action,archive / unarchive / restore)| `POST /cms/{resource}/:id/{action}` |

### 2.2 為什麼不允許 user-side 寫入

| 原因 | 細節 |
|---|---|
| Auth 一致性 | `/cms` scope-level `requireAdmin` preHandler(spec 023 §4.4)一次掛,新增 endpoint 自動受保護。`/user/v{N}` 沒這個 hook;分散寫入 = 漏掛保護的風險 |
| Rate-limit policy | `/cms` 用 admin 雙層(per-user + per-IP);`/user/v{N}` 是 public(per-IP 為主)。寫入操作走錯 surface = rate-limit policy 不對齊 |
| Audit / 觀測性 | `/cms` 路徑明確標示「這是後台動作」,log / metric 過濾 `routerPath` 帶 `/cms/*` 即可看出後台操作;混雜 `/user/v{N}` 寫入會污染 metric 維度 |
| Cache invalidation | spec 019 / 020 §8 規範:寫入觸發失效;讓所有寫入收斂在 `/cms` plugin scope,未來可在 plugin 加共用 `onResponse` hook 統一 invalidation,不漏路徑 |
| URL 對 client 的語意 | URL 直接告知 caller「這是需要 admin 權限的操作」;混雜會誤導 |

### 2.3 Order 為什麼例外

`Order` 是**交易紀錄**,不是被管理的 entity。差別:

| 維度 | Entity(Charity / Project / Sale) | Order |
|---|---|---|
| 創建來源 | admin 在 CMS 介面建立 | **使用者**在 Figma 結帳 modal 建立(spec 022 §2.1 / Figma IMG_4885-4887)|
| 創建頻率 | 低(admin 手動)| 高(每次捐款 / 購買產生一筆)|
| 創建時的 auth 要求 | required(admin role=0)| **無**(spec 022 §2.1 明文規約 — Figma UX 不能有 auth wall)|
| 持有者語義 | 後台管理員 | 「持有 orderId 的人」(UUIDv4 不可枚舉視同擁有者,spec 022 §2.1 風險表 v0.7)|

→ Order 的「create」是**業務交易流程**(結帳),不是「資源管理」。同理:
- `POST /confirm-payment`(mock 結帳)— 交易流程
- `POST /cancel`(user 取消)— 交易流程
- `GET /:id`(分享連結)— 交易讀取

這四個放在 `/user/v1/donation/orders/*`(spec 022 §3.1)。

而 Order 的 **admin 視角操作**(改 status / donorName / paidAt 等,admin 改錯時的修復)屬於後台管理:
- `GET /cms/orders`(admin list with filter)
- `GET /cms/orders/:id`(admin detail)
- `PATCH /cms/orders/:id`(admin 改 status / donorName / paidAt / cancelledAt / note / receiptOption / isAnonymous)
- `DELETE /cms/orders/:id`(admin hard delete)

放在 `/cms/orders/*`(spec 022 §3.2,已實作)。

> **本 spec 不把 Order 的 admin PATCH/DELETE 視為違反 invariant** — Order 雖非 entity,但**後台對 Order 的管理操作仍走 `/cms`**,跟 entity CUD 的 surface 規約一致。也就是 invariant 的精確版本是:**所有需要 admin 權限的寫入(無論對 entity 還是對 Order 等交易紀錄)一律走 `/cms`**。

---

## 3. 當前落地清單

### 3.1 Entity CUD(全部在 `/cms`)

| Entity | C | U | D | Lifecycle |
|---|---|---|---|---|
| Charity | `POST /cms/donation/charities` | `PATCH /cms/donation/charities/:id` | `DELETE /cms/donation/charities/:id` | `POST /:id/{archive,unarchive,restore}` |
| DonationProject | 同上樣板 | 同 | 同 | 同 |
| SaleItem | 同 | 同 | 同 | 同 |
| Category | ❌(字典表,固定 16 筆;spec 020 §2.5)| `PATCH /cms/donation/categories/:id`(只能改 displayName / displayNameEn / displayOrder) | `DELETE` | `POST /:id/{archive,unarchive,restore}` |

全部對應 spec 020 §5 落地;`registerLifecycleRoutes` 共用 factory 在 `src/routes/v1/donation/lifecycle-routes-helper.ts`(命名待 spec 023 階段 3 cleanup 時改為 `src/routes/cms/lifecycle-routes-helper.ts`,本 spec 不規範 file rename)。

### 3.2 Account(身分 entity,例外路徑)

Account 的「CUD」分布:
- **C(reate)**:走 `/auth/register`(spec 008,**不**在 `/cms`)
- **U(pdate)**:走 `/auth/me`(spec 008 §6,使用者自助;**不**在 `/cms`)
- **D(elete)**:走 `/auth/me/archive` + `DELETE /auth/me`(spec 008 §6.6 / §6.7,使用者自助)
- **Admin 視角的 Account 管理**:**未實作**(spec 020 §14 OQ #10 列為未來工作 — 第一個 admin 走 bootstrap script;後續可能加 `/cms/accounts` admin 看 / 改 / 鎖帳號)

→ Account 自助 CRUD 走 `/auth`(身分 surface),**不**算違反本 spec invariant,因為它是**使用者對自己**的操作,不是 admin 對其他人的管理操作。未來真要做 admin 端的 Account 管理(列出所有 user / 強制 archive / 改 role),才走 `/cms/accounts`。

### 3.3 Order(admin 視角,非 entity,但歸 `/cms`)

| 動作 | URL | 落地版本 |
|---|---|---|
| List | `GET /cms/orders` | spec 022 §4.7 |
| Detail | `GET /cms/orders/:id` | spec 022 §4.8 |
| Update | `PATCH /cms/orders/:id` | spec 022 §4.9 |
| Delete | `DELETE /cms/orders/:id` | spec 022 §4.10 |

→ **本 spec 不要求新增任何 admin Order endpoint** — 既有 4 個已涵蓋後台需求。

### 3.4 Order(使用者視角,交易流程,在 `/user/v1`)

| 動作 | URL | 落地版本 |
|---|---|---|
| Create(charity-donation 結帳) | `POST /user/v1/donation/orders/charity-donation` | spec 022 §4.1 |
| Create(project-donation 結帳) | `POST /user/v1/donation/orders/project-donation` | spec 022 §4.2 |
| Create(sale-item-purchase 結帳) | `POST /user/v1/donation/orders/sale-item-purchase` | spec 022 §4.3 |
| Detail(持有 orderId)| `GET /user/v1/donation/orders/:id` | spec 022 §4.6 |
| Confirm payment(mock 結帳) | `POST /user/v1/donation/orders/:id/confirm-payment` | spec 022 §4.4 |
| Cancel(user 取消)| `POST /user/v1/donation/orders/:id/cancel` | spec 022 §4.5 |

→ 全部維持原狀,**不**遷至 `/cms`(理由 §2.3)。

---

## 4. 新增 entity / endpoint 時的決策樹

問問題的順序:

```
這個操作是 admin 後台管理嗎?
├─ 是 → /cms/{resource}/{...}
│       (sub-surface 自動套 requireAdmin + 雙層 rate-limit)
└─ 否 → 這是身分相關嗎?
        ├─ 是 → /auth/{...}
        │       (auth surface,不版本化)
        └─ 否 → /user/v{N}/{...}
                (使用者業務 API,版本化)
```

| 場景 | 決策 |
|---|---|
| 加新 entity(`Volunteer` / `Event`)的 CUD | `/cms/volunteers/*` / `/cms/events/*`(invariant 適用) |
| 加 entity 的 public read | `/user/v{N}/{resource}/*` |
| 加交易流程(類似 Order 的「結帳 / 確認 / 取消」)| `/user/v{N}/{...}` 為 public,`/cms/{...}` 為 admin 視角(同 Order 模式) |
| 加 user-self profile / 設定 | `/auth/me/{...}`(spec 008 §6 樣板) |

---

## 5. 未來規劃

### 5.1 User-side Order Update(spec 022 §11 OQ #2 的可能落地)

目前持有 orderId 的人只能 `GET /:id` / `confirm-payment` / `cancel`。未來若使用者要在結帳後修改自己的訂單資訊(改 donorName / receiptOption / note / isAnonymous),要做:

| 設計選項 | 評估 |
|---|---|
| A. `PATCH /user/v1/donation/orders/:id`,持有 orderId 視同擁有者 | UUID 不可枚舉視同 token;與既有 GET / cancel 一致。**簡單但弱安全**(orderId 被分享 / log 洩露即任何人能改)|
| B. 加 `manageToken` 機制(create 時 server 發 token,後續 PATCH 要帶)| 真實世界 e-commerce 標準作法;需 spec 022 補章節定 token shape + 失效規則 |
| C. 走 email magic link(send link to donorEmail → click → 進編輯頁) | 需寄信能力(spec 011 / 014 OQ #4) |

**本 spec 不選方案**;若真要落地走 spec 022 補丁 v0.11+ + 新 ADR。**本 spec 規範路徑**: 該 endpoint 落 `/user/v{N}/donation/orders/:id`,**不**到 `/cms`(因為操作者是 user 自己,非 admin)。

### 5.2 Admin Account Management(spec 020 §14 OQ #10)

未來若要實作後台管理 Account:

```
GET    /cms/accounts                列出所有帳號(admin)
GET    /cms/accounts/:id            看單一帳號
PATCH  /cms/accounts/:id            改 role / archivedAt / displayOrder
DELETE /cms/accounts/:id            hard delete(極謹慎)
POST   /cms/accounts/:id/archive    強制封存
POST   /cms/accounts/:id/unarchive  解封
```

完全對齊 invariant。

### 5.3 新業務 entity(假設未來加 `Event`)

走 spec 020 同樣樣板:
- `/user/v{N}/donation/events`(public read)
- `/cms/donation/events`(admin CUD + 4 lifecycle)
- spec 編號 026+

invariant 適用,不需特別規約。

---

## 6. Open questions

| # | 問題 | 暫定方向 |
|---|---|---|
| 1 | 「需要 admin 權限的 read」(例:看所有匿名訂單 donorName)算 CUD 嗎? | **否**,但仍歸 `/cms` — 因為 read 結果含 admin-only 資訊(如完整 donorName 不 mask)。spec 023 §2.3 的「admin surface」精確版本應為「需要 role=0 的操作 = `/cms`」 |
| 2 | `/cms` 是否需要 sub-versioning? | 不需要(spec 023 §2.3);跟 backend 同步部署 |
| 3 | ~~既有 `/cms/orders`(不含 `/donation` 中綴)是否該改 `/cms/donation/orders` 以對齊 entity CUD 命名?~~ | ✅ **v0.2 收束 — 保留現狀,不改**。理由:(a) Order **不是** donation entity 的子資源(§2.3 — Order 為 trade record;Charity/Project/Sale 是 entity;Order 跨多個 donation 資源);(b) 改 URL 等於 breaking change,既無業務需求也不對齊 entity invariant 改善;(c) `cms/orders.ts` file path 已對齊 URL(spec 023 v0.2 §6.3 釐清歷史脈絡) |
| 4 | invariant 違反的 lint / 檢查機制 | 未來可加 CI 規約:grep `app.route` URL 字串確認 entity CUD 落 `/cms`;本期人工 review |

---

## 7. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-16 | 初版 — 鎖死「entity CUD → `/cms`」invariant;Order 為交易流程例外;Account 為身分自助例外;新增 entity 決策樹;§5 列未來 user-side order update / admin account management / 新業務 entity 的擴展路徑。對應 spec 023 §2.3 的補強 |
| 0.2 | 2026-06-16 | §6 OQ #3 收束 — `/cms/orders` 保留現狀(不改 `/cms/donation/orders`),理由:Order 非 donation entity 的子資源 + 改 URL 是 breaking 而無業務需求。對應 spec 023 v0.2 §6.3 同步釐清 |
