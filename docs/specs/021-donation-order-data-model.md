# Spec 021:Donation Order Data Model(Order header + OrderLine 線項 + 4 enum)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.8 |
| 日期 | 2026-06-15 |
| 適用範圍 | `backend/prisma/schema.prisma`(Order / OrderLine / 4 enum 新增)、`backend/prisma/migrations/<ts>_add_donation_orders/`(新)、`backend/src/domain/order/*`(新 directory)、`backend/src/lib/clock.ts`(新,§7.7 Clock 注入)|
| 相關 ADR | 待補(預計 `docs/decisions/013-donation-order-model.md`)|
| 相關 spec | `015-charity-data-model.md` v0.10、`022-donation-order-api.md`(本 spec 對應 API)、`005-error-handling.md`、ADR 006 lifecycle / cascading visibility |
| 設計來源 | Figma 截圖補件 IMG_4885 / 4886 / 4887,2026-06-15 |

---

## 1. 目的與範圍

### 1.1 目的

對應 Figma「點擊捐款 / 購買」開啟的設定 modal 流程,在 backend 落實**訂單資料模型**。本 spec 只規範 schema、enum、domain invariant、migration;HTTP 端點規約見 spec 022。

**v0.2 大改**:從原本「Order 直接帶 entity FK」(spec 021 v0.1)改為 **OrderLine pattern**(Order 為 header,OrderLine 承擔 polymorphic FK + 線項資料)。理由見 §2.2。

### 1.2 訂單形式(由截圖揭露)

| 來源資源 | UI 元素 | 統一表達 |
|---|---|---|
| Charity(IMG_4885) | 類型 × 扣款日 × 金額 | Order + 1 OrderLine(subjectType=CHARITY,quantity=1,unitPriceTwd=用戶輸入金額) |
| DonationProject(IMG_4886) | 同上 | Order + 1 OrderLine(subjectType=DONATION_PROJECT)|
| SaleItem(IMG_4887) | 商品 × 數量 + 運費 + 總計 | Order + N OrderLine(subjectType=SALE_ITEM,quantity=數量)|

所有訂單**結構統一**:Order header + ≥1 OrderLine。捐款與義賣只是 OrderLine 上 `subjectType` 不同。

### 1.3 In scope

- `Order`(header)+ `OrderLine`(線項)兩張表 + 4 個 enum
- OrderLine 上的 polymorphic FK 設計(charityId / donationProjectId / saleItemId,nullable + subjectType discriminator)
- 訂單狀態 state machine
- Domain-level invariant
- Index 策略
- Prisma migration 形狀

### 1.4 Out of scope(本期不做)

- 使用者登入(訂單**不關聯** Account,§2.1)
- 庫存(SaleItem.stockQty)
- 物流(Address 表)
- 運費(`Order.shippingFeeTwd`)
- RECURRING 訂閱獨立成 `RecurringDonation` 表 + 自動扣款(§2.3)
- 退款 / 部分退款的資料模型
- 訂單收據 / 通知信
- **本期 OrderLine 上限為 1 條**(對應 IMG_4887 單品 UI);Cart 多 line 留 spec 022 §11 OQ #3

---

## 2. 架構評估

### 2.1 訂單**不關聯** Account 表(完全匿名)

#### 決策

`Order.donorName` 是自由字串(`VarChar(120)`),不 unique、不引用 Account.id。

#### 設計取捨

| 議題 | 結論 |
|---|---|
| `donorName` vs `username` | **`donorName`**(不用 `username` 避免與 `Account.username` 撞語意) |
| 訂單歸屬 | 無 end-user 歸屬;admin(role=0)可看所有訂單(spec 022)|
| Account 表角色 | 此後**只服務 admin**(role=0 spec 020);end user 不需登入 |

### 2.2 OrderLine pattern(關鍵改動 v0.1 → v0.2)

#### 動機

v0.1 把 entity FK(`charityId` / `donationProjectId`)放在 `Order` 上,造成兩個問題:

1. **結構不對稱**:donation 用 Order 上 FK + 0 個 OrderItem;sale-item 用 0 FK + N 個 OrderItem。兩種 shape 並存
2. **加新類型摩擦**:每加一個 subject type 都要動 Order 表 + 5 處 code(invariant / validator / create-service / API body / OpenAPI)

#### 決策:Order header + OrderLine 線項

**Order** 變成 entity-agnostic header,只裝共用欄位(status / donorName / amountTwd / paidAt / cancelledAt)。**OrderLine** 承擔「訂單買了 / 捐了什麼」的多型對應:

```
Order(header)
  └─ OrderLine[] (≥1)
       ├─ subjectType: CHARITY | DONATION_PROJECT | SALE_ITEM | <未來擴充>
       ├─ polymorphic FK: charityId? / donationProjectId? / saleItemId? (DB integrity)
       ├─ quantity, unitPriceTwd, subtotalTwd
       └─ donationFrequency?, billingDay? (僅 CHARITY / DONATION_PROJECT)
```

#### 對應的訂單形式

| 訂單 | Order 設定 | OrderLine |
|---|---|---|
| 捐 500 給 Charity X(單次) | amountTwd=500 | 1 line(subjectType=CHARITY,charityId=X,quantity=1,unitPriceTwd=500,donationFrequency=ONE_TIME) |
| 每月 26 日捐 500 給 Project Y | amountTwd=500 | 1 line(subjectType=DONATION_PROJECT,donationProjectId=Y,donationFrequency=RECURRING,billingDay=DAY_26)|
| 買 SaleItem Z × 2 件(449/件) | amountTwd=898 | 1 line(subjectType=SALE_ITEM,saleItemId=Z,quantity=2,unitPriceTwd=449,subtotal=898)|

#### 為什麼用 polymorphic FK 而非 opaque(無 FK)reference

評估過「opaque subjectId(無 FK)」方案,放棄理由:

| Opaque 方案的代價 | 影響 |
|---|---|
| 沒 DB FK constraint | 可以寫進不存在的 subjectId,DB 不擋 |
| 沒 ON DELETE 行為 | charity hard delete 後 OrderLine 變孤兒 |
| Prisma client 無型別 | `line.charity` 沒了,要 polymorphic dispatcher |
| Cascading visibility 散落 | 公開查詢 join 要在應用層手動補 |

opaque 適合「subject 類型超頻繁變動」的 SaaS 多租戶情境,**不適合本作業**。OrderLine 上保留三個 nullable typed FK + `subjectType` discriminator,加新類型仍需 schema migration,但摩擦**集中在 OrderLine 一個表**而非散在 Order 各處。

#### 對未來「Cart / 混合單」的解鎖

| 情境 | 用 OrderLine pattern |
|---|---|
| 一次買 3 個義賣商品 | 1 Order + 3 OrderLine(都 subjectType=SALE_ITEM) |
| 同單捐 100 給 charity + 買 1 個義賣 | 1 Order + 2 OrderLine(混 subjectType)|
| 加新類型 EventTicket | OrderLine 加 `eventTicketId?` + enum + validation;**Order 不動** |

本期 §1.4 仍限制 OrderLine ≤ 1 條(對應 IMG_4887 單品 UI),但 schema 已 future-proof。

### 2.3 RECURRING 訂閱「不獨立成表」

#### 決策

不建 `RecurringDonation` 表;改在 **OrderLine** 上加兩欄(v0.1 是 Order 上;v0.2 跟著 OrderLine 一起移動):

```
donationFrequency  DonationFrequency?    // 僅對 CHARITY / DONATION_PROJECT 有意義
billingDay         BillingDay?           // RECURRING 必設
```

#### 為什麼這樣設計

- 本期不做自動扣款 — 訂閱只有「一次建立」事件,沒 N 個衍生 transaction
- 單筆 OrderLine 帶 `frequency=RECURRING, billingDay=DAY_26` 已完整表達使用者意圖
- 未來真做自動扣款時:
  - 升 `RecurringDonation` 訂閱表(由 OrderLine 引申)
  - 每月 cron 觸發產生新 Order(reference 回訂閱)
  - 本期 schema 不需破壞性變動

### 2.4 SaleItem 不做庫存 / 物流 / 運費

| IMG_4887 元素 | 本 spec 落地 |
|---|---|
| 「運費 TWD 0」 | UI 寫死,backend 不存 |
| 「總計 TWD 449」 | = sum(OrderLine.subtotalTwd) |
| 數量 ±(加減) | 接受,quantity ∈ [1, 100] |
| 收件地址(未截圖) | 略過 |

未來:spec 023 加 Address + 運費;spec 024 加庫存(OrderLine.create 時 atomic decrement)。

### 2.5 Domain layer 檔案結構

```
src/domain/order/                          ← 新 directory
  create-services.ts        createCharityDonation / createProjectDonation / createSaleItemPurchase
  lifecycle-services.ts     confirmPayment / cancelOrder
  query-services.ts         getOrder / listOrdersForAdmin
  line-builder.ts           三個 create-service 共用的 OrderLine 構造邏輯
  validators.ts             subjectType ↔ FK invariant + frequency / billingDay invariant(§7)
```

並列於 `src/domain/donation-item/`(charity / project / sale 主資源);**不**放進 donation-item/ 因為訂單是獨立業務概念。

---

## 3. Prisma Schema

```prisma
enum OrderStatus {
  PENDING     // 已建立,等待付款
  PAID        // 付款成功(本期 mock confirm)
  CANCELLED   // 使用者取消(僅 PENDING 可)
  FAILED      // 付款失敗(本期不主動觸發,留欄位給未來真 gateway)
  REFUNDED    // 已退款(admin PATCH)
}

enum OrderSubjectType {
  CHARITY            // 捐 charity
  DONATION_PROJECT   // 捐 project
  SALE_ITEM          // 買 sale item
  // 未來:EVENT_TICKET / MEMBERSHIP / MERCHANDISE / ...
}

enum DonationFrequency {
  ONE_TIME
  RECURRING
}

enum BillingDay {
  DAY_6
  DAY_16
  DAY_26
}

// v0.5 — 收據開立方式(對應 IMG_4888 / 4889 dropdown「都不需要 / ...」)
enum ReceiptOption {
  NONE                 // 都不需要(預設;UI 顯示「都不需要」)
  INDIVIDUAL           // 個人收據
  CORPORATE            // 公司收據
  GOVERNMENT_DONATION  // 捐贈政府(常見公益選項)
  DEFER                // 留待後續處理
}

model Order {
  id          String      @id @default(uuid())
  status      OrderStatus @default(PENDING)

  donorName   String      @db.VarChar(120)

  // v0.5 — 是否匿名捐款。Charity 捐款 (IMG_4888「我要匿名捐款」
  // checkbox) / DonationProject 捐款 (IMG_4889 同位置) / SaleItem 購買
  // (IMG_4890 同位置) 三類訂單共用此選項(v0.8 釐清:不限 SaleItem)。
  // 影響 public display(隱去 donorName 改顯示「匿名捐款者」);收據仍用 donorName
  isAnonymous Boolean     @default(false)

  // v0.5 — 收據開立方式(IMG_4888/4889 dropdown,對 CHARITY/PROJECT_DONATION 必填)
  // SALE_ITEM_PURCHASE: 必須為 null(IMG_4890 沒此 dropdown);見 §7 invariant
  receiptOption ReceiptOption?

  // v0.4 — 訂單備注(整單共用,**不** per-line);常見用途:
  //   - donation:「無名氏捐款,請勿公開姓名」
  //   - sale-item:「請放門口」
  //   - 任何使用者自由文字
  // optional;空白 trim 後若 = "" 由 service 層轉 null
  note        String?     @db.VarChar(500)

  // v0.5 — 下次扣款日(僅 RECURRING 有值;ONE_TIME 與 SALE_ITEM 為 null)
  // backend 算 + 存(§7 規則);本期不做 cron 扣款,純為 UI 顯示用;未來自動扣款上線時直接讀
  nextChargeAt DateTime?

  // 訂單總金額(denormalized:= sum(OrderLine.subtotalTwd))
  // 應用層在 create / line CRUD 時必須同步;本期 OrderLine 不可後修(immutable
  // post-create),所以 amountTwd 算一次就鎖
  amountTwd   Int

  paidAt      DateTime?
  cancelledAt DateTime?

  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  lines       OrderLine[]

  @@index([status, createdAt])
  @@index([nextChargeAt])              // v0.5 — 未來 cron「找出今日該扣款的 order」走此 index
  @@map("orders")
}

model OrderLine {
  id        String   @id @default(uuid())
  orderId   String
  order     Order    @relation(fields: [orderId], references: [id], onDelete: Cascade)

  // Subject 多型對應
  subjectType  OrderSubjectType

  // Polymorphic FK(nullable typed columns 保 DB integrity;見 §2.2)
  charityId         String?
  charity           Charity?         @relation(fields: [charityId], references: [id], onDelete: Restrict)

  donationProjectId String?
  donationProject   DonationProject? @relation(fields: [donationProjectId], references: [id], onDelete: Restrict)

  saleItemId        String?
  saleItem          SaleItem?        @relation(fields: [saleItemId], references: [id], onDelete: Restrict)

  // 線項基本資料
  quantity              Int   // ≥ 1,≤ 100
  unitPriceTwd          Int   // CHARITY/PROJECT:= 用戶輸入金額;SALE_ITEM:= SaleItem.priceTwd 建單時 snapshot
  subtotalTwd           Int   // = quantity × unitPriceTwd(本期 quantity 對 donation 永遠 1)

  // 捐款 specific(僅 subjectType ∈ {CHARITY, DONATION_PROJECT} 設)
  donationFrequency DonationFrequency?
  billingDay        BillingDay?

  createdAt   DateTime @default(now())

  @@index([orderId])
  @@index([charityId])
  @@index([donationProjectId])
  @@index([saleItemId])
  @@index([subjectType, createdAt])         // admin filter「過去 X 天的某 subjectType」
  @@map("order_lines")
}
```

### 3.1 與既有 schema 的串接

`Charity` / `DonationProject` / `SaleItem` 各加一個反向 relation:

```prisma
model Charity {
  // ...
  orderLines  OrderLine[]
}
model DonationProject {
  // ...
  orderLines  OrderLine[]
}
model SaleItem {
  // ...
  orderLines  OrderLine[]
}
```

#### 反向 relation 的 migration impact(v0.3 補)

Prisma 反向 relation **純 client 端概念**,不產生 SQL 改動:

- migration.sql 不會多任何 DDL
- 既有 testcontainers DB 跑既有 migration history 即可,**不需** `prisma migrate reset`
- 既有 200+ integration test 不受影響,因為三個主表的 schema(欄位、index、constraint)完全不變
- `prisma generate` 後 client 多出 `charity.orderLines` accessor;若 admin / public read 不查 `orderLines`,該 accessor 不被使用,gen + build 一切照常

### 3.2 為什麼 `unitPriceTwd` 不叫 `unitPriceTwdSnapshot`

- 對 CHARITY / DONATION_PROJECT:不是 snapshot 而是「使用者當下輸入的捐款金額」
- 對 SALE_ITEM:是 SaleItem.priceTwd 建單時的 snapshot
- 兩種語意都用同一欄,選通用名 `unitPriceTwd`;在 §7 invariant 表用註解清楚說明來源

---

## 4. Migration plan

### 4.1 內容

1. `CREATE TYPE OrderStatus / OrderSubjectType / DonationFrequency / BillingDay`(4 個)
2. `CREATE TABLE orders` + FK + index
3. `CREATE TABLE order_lines` + 4 FK + 5 index
4. **Re-assert trgm GIN indexes**(spec 015 §4.2)— 沿用 spec 008 v0.4 / spec 020 patten 手寫 `CREATE INDEX IF NOT EXISTS`

### 4.2 命名

`<ts>_add_donation_orders/migration.sql`,`ts` 由 `prisma migrate dev --create-only` 產生。

### 4.3 本地流程

```
1. 改 prisma/schema.prisma(本 spec §3)+ Charity / Project / SaleItem 反向 relation
2. npx prisma migrate dev --create-only --name add_donation_orders
3. 編輯 migration.sql:
   - 拿掉所有 DROP INDEX 的 trgm 行
   - 在尾段加 CREATE INDEX IF NOT EXISTS 的 trgm 12 行
4. npx prisma migrate reset --skip-seed --force
5. 驗證 psql 看 4 enum + 2 表 + 6 index + trgm 全 12 個都在
```

---

## 5. 訂單狀態 State Machine

(與 v0.1 不變)

```
       create order
            │
            ▼
        ┌──────────┐
        │ PENDING  │
        └────┬─────┘
             │
   ┌─────────┼──────────────────┐
   │ confirm │ cancel           │
   ▼         ▼                  ▼
┌──────┐ ┌───────────┐       (未來:gateway timeout)
│ PAID │ │ CANCELLED │       → FAILED
└──┬───┘ └───────────┘
   │
   │ admin PATCH status = REFUNDED
   ▼
┌──────────┐
│ REFUNDED │
└──────────┘
```

合法轉換、idempotency、admin override 規則同 v0.1。

---

## 6. Index 策略

| Index | 用途 |
|---|---|
| `Order.@@index([status, createdAt])` | admin list `?status=X` 加排序 |
| `OrderLine.@@index([orderId])` | 反向取某 order 的所有 line |
| `OrderLine.@@index([charityId])` | 「這間 charity 收到多少訂單」 |
| `OrderLine.@@index([donationProjectId])` | 同上 project |
| `OrderLine.@@index([saleItemId])` | 「這個 SaleItem 被買過幾次」 |
| `OrderLine.@@index([subjectType, createdAt])` | admin list `?subjectType=X&dateFrom=Y` |

`donorName` 不建索引(無 user-facing search by donorName);admin 從 donorName 搜尋走 full scan,未來可加 trgm。

---

## 7. Domain-level invariants

`src/domain/order/validators.ts` 必須驗證:

### 7.1 subjectType ↔ FK 對應

```ts
switch (line.subjectType) {
  case 'CHARITY':
    assert(line.charityId !== null)
    assert(line.donationProjectId === null)
    assert(line.saleItemId === null)
    break
  case 'DONATION_PROJECT':
    assert(line.donationProjectId !== null)
    assert(line.charityId === null)
    assert(line.saleItemId === null)
    break
  case 'SALE_ITEM':
    assert(line.saleItemId !== null)
    assert(line.charityId === null)
    assert(line.donationProjectId === null)
    break
}
```

違反 → throw `InvariantError`(500) — 程式 bug,非 user error。

### 7.2 frequency ↔ billingDay 對應(只對 donation 類)

```ts
const isDonation = ['CHARITY', 'DONATION_PROJECT'].includes(line.subjectType)
if (isDonation) {
  assert(line.donationFrequency !== null)
  if (line.donationFrequency === 'RECURRING') {
    assert(line.billingDay !== null)
  } else {
    assert(line.billingDay === null)
  }
} else {  // SALE_ITEM
  assert(line.donationFrequency === null)
  assert(line.billingDay === null)
}
```

User-facing validation(`/v1/donation/orders/*` body)在 service 層處理,失敗 → 400 `INVALID_BILLING_DAY`;這裡的 invariant 是「絕不能進 DB 的狀態」,500 fail-loud。

### 7.3 金額一致性

```ts
// OrderLine 內部
for (const line of order.lines) {
  assert(line.subtotalTwd === line.quantity * line.unitPriceTwd)
  assert(line.quantity >= 1 && line.quantity <= 100)
}
// Order header 對 lines 加總
const sum = order.lines.reduce((acc, l) => acc + l.subtotalTwd, 0)
assert(order.amountTwd === sum, 'Order.amountTwd must equal sum of OrderLine.subtotalTwd')
```

### 7.4 本期 line count 限制

```ts
assert(order.lines.length === 1, '本期 OrderLine 數量必須 = 1(spec 022 §11 OQ #3 未來放寬)')
```

未來支援 cart 時刪掉此 assert。

### 7.5 receiptOption ↔ subjectType 對應(v0.5)

```ts
// 由本期 line count = 1 推得:整單只有一個 subjectType
const subjectType = order.lines[0].subjectType
if (subjectType === 'SALE_ITEM') {
  assert(order.receiptOption === null, 'SALE_ITEM_PURCHASE 無收據開立方式(IMG_4890 沒此 dropdown)')
} else {
  // CHARITY / DONATION_PROJECT 必填
  assert(order.receiptOption !== null, 'CHARITY/PROJECT donation 必選 receiptOption')
}
```

未來 cart 混合單(donation + sale-item 同單)需要重新評估;§10 OQ 待辦。

### 7.6 nextChargeAt ↔ donationFrequency 對應(v0.5)

```ts
// 同樣假設 line count = 1
const line = order.lines[0]
if (line.donationFrequency === 'RECURRING') {
  assert(order.nextChargeAt !== null, 'RECURRING 必有 nextChargeAt')
} else {
  // ONE_TIME / SALE_ITEM
  assert(order.nextChargeAt === null)
}
```

### 7.7 nextChargeAt 計算邏輯(v0.5)

僅在 RECURRING 訂單 create 時呼叫:

```ts
function computeNextChargeAt(now: Date, billingDay: BillingDay): Date {
  const day = ({ DAY_6: 6, DAY_16: 16, DAY_26: 26 })[billingDay]
  const todayUtcDate = now.getUTCDate()
  const target = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() + (todayUtcDate < day ? 0 : 1),
    day, 0, 0, 0, 0
  ))
  return target
}
```

| 今日(UTC date) | billingDay | nextChargeAt |
|---|---|---|
| 2026-06-15 | DAY_16 | 2026-06-16 00:00:00 UTC |
| 2026-06-16 | DAY_16 | 2026-07-16 00:00:00 UTC(當天視為已過,改下個月)|
| 2026-06-20 | DAY_16 | 2026-07-16 00:00:00 UTC |
| 2026-06-30 | DAY_6 | 2026-07-06 00:00:00 UTC |

> **規則**:「當天」算「已過」(因為訂單建立時間 ≥ 00:00:00 UTC,當天 billingDay 已經錯過扣款窗)。實作判斷用 `todayUtcDate < day`(嚴格小於)。
> Edge case:billingDay 只有 6/16/26,所有月份都存在(不會碰到 2/30 這種日);若未來加 DAY_31 需特例處理。

#### Clock 注入(v0.7)

`computeNextChargeAt(now: Date, billingDay: BillingDay)` 是**純函式**;**service 層不可直接 `new Date()`**,`now` 必須從外部注入。

| 環境 | 注入方式 |
|---|---|
| Production | Fastify decorator:`app.decorate('clock', () => new Date())`;route handler 取 `req.server.clock()` 後傳入 service |
| Unit test | service 函式 signature 含 `deps: { clock: () => Date }`;test 直接傳 fixed `Date` |
| Integration test | `vi.useFakeTimers()` + `vi.setSystemTime('2026-06-15T08:00:00.000Z')`,production decorator 不改 |

```ts
// src/lib/clock.ts
export type Clock = () => Date
export const systemClock: Clock = () => new Date()

// src/domain/order/create-services.ts
export async function createCharityDonation(
  input: CharityDonationBodyT,
  deps: { prisma: PrismaClient; clock: Clock },
): Promise<Order> {
  const now = deps.clock()
  // ...
  const nextChargeAt = input.donationFrequency === 'RECURRING'
    ? computeNextChargeAt(now, input.billingDay!)
    : null
  // ...
}
```

呼應 backend CLAUDE.md「可 mock 時間 / 隨機:vi.useFakeTimers、注入 clock / id 產生器,確保測試決定性」。

#### `nextChargeAt` 只算一次,不重算(v0.6 補)

| 觸發 | 是否重算 nextChargeAt | 理由 |
|---|---|---|
| `POST /v1/donation/orders/*` create | ✅ 算一次,寫進 DB | 對應 §7.7 公式 |
| `POST /:id/confirm-payment` | ❌ 不重算 | 付款行為不影響「下次扣款日」 |
| `POST /:id/cancel` | ❌ 不重算 | 取消後 nextChargeAt 留原值(對 admin 統計仍有意義)|
| admin `PATCH /:id`(改 status / paidAt / cancelledAt / donorName / isAnonymous / receiptOption / note) | ❌ 不重算 | admin PATCH 不能改 `lines` / `billingDay`,nextChargeAt 計算來源沒變 |
| 未來 cron 自動扣款後 | ✅ 推到下個月 | 本期不做;cron 上線時 cron service 自己負責推進 |

`nextChargeAt` 在 `Order` 表上是**準 immutable**(僅 cron 服務有寫入權限,本期 cron 不存在故等同 immutable)。

### 7.5 Lifecycle FK 對應 live

create 時驗對應 entity 通過 `whereLive` / `whereLiveWithParent`:

| subjectType | 驗證 |
|---|---|
| `CHARITY` | `whereLive(now)` 通過 |
| `DONATION_PROJECT` | `whereLiveWithParent(now)` 通過(自己 + parent Charity)|
| `SALE_ITEM` | `whereLiveWithParent(now)` 通過 |

不通過 → 404(spec 022 §4)。

---

## 8. Seed strategy

本期**不**對 orders / order_lines 表 seed — 訂單為 user-generated 資料,seed 會混淆「真實使用 vs 演示資料」。

---

## 9. Test strategy(model + domain layer)

### 9.1 Unit(`src/domain/order/**/*.test.ts`)

- `validators.ts` 5 條 invariant 各 1-2 test
- 5 個 enum mapping 完整性
- OrderLine `subtotalTwd` 算術
- Order `amountTwd` 對 lines 加總

### 9.2 Integration(對 DB)

放在 spec 022 的 integration test(每個 create endpoint 必驗 DB row);schema 層面的 invariant 透過 application code 強制,不在 DB CHECK。

### 9.3 Migration round-trip

`prisma migrate reset --skip-seed --force` 走過所有 migration 不報錯,且 trgm GIN indexes 全 12 個還在。

---

## 10. Open questions(model-only)

| # | 問題 | 暫定方向 |
|---|---|---|
| 1 | RECURRING 真做扣款時的訂閱 schema | 升 `RecurringDonation` 表 + `Order.recurringDonationId` FK;每月 cron 產 ONE_TIME order |
| 2 | SaleItem 庫存 / 物流 / 運費 | spec 023(假設)— `Address` 表 + `Order.shippingAddressId` + `Order.shippingFeeTwd` |
| 3 | 退款 unit-level vs whole-order | 本期只支援整單 REFUNDED;部分退款需 `RefundLine` 子表(未來 ADR) |
| 4 | 訂單 audit table(改動歷史)| 本期靠 logger(spec 022 §9);未來合規驅動 DB-persisted audit |
| 5 | OrderLine 是否 snapshot 商品名 / 描述? | 本期不;admin 看 historic name 查 SaleItem detail 即可 |
| 6 | `donorName` 是否 full-text index? | 本期不;日後可加 trgm |
| 7 | hard delete vs soft delete | hard delete(訂單事實紀錄不該 archive;留會混淆統計) |
| 8 | 加新 OrderSubjectType(EventTicket / Membership / ...) | OrderLine 加 nullable FK + enum value + validator case;Order 表不動 |
| 9 | 收據開立後的收件資訊(email / 統編 / 地址) | INDIVIDUAL / CORPORATE 真的要寄收據時需收 contact;新加 `Order.receiptEmail` / `receiptTaxId` / `receiptAddress`;本期不做(無寄信能力)|
| 10 | 未來 cart 混合單(donation + sale-item 同單)時 receiptOption 怎麼處理 | 可能改成 per-line 或 per-Order「mixed cart 預設 INDIVIDUAL」;本期 line count=1 不衝突 |

---

## 11. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-15 | 初版(從 021-donation-order-api.md 拆出 model 部分)— Order 直接帶 entity FK + sale 用 OrderItem 表 |
| 0.2 | 2026-06-15 | **重大改寫**:採 **OrderLine pattern** — Order 變 entity-agnostic header,所有 subject 統一走 OrderLine + polymorphic FK + subjectType discriminator。三個動機:(1) 解決 v0.1 donation vs sale 結構不對稱;(2) 為未來 cart / 混合單(多 OrderLine in same Order)鋪路;(3) 加新 OrderSubjectType 的摩擦集中於 OrderLine 表而非散在 Order 各處。`donationFrequency` / `billingDay` 一起移到 OrderLine。對應 spec 022 v0.2 同步 |
| 0.3 | 2026-06-15 | 補可開發性細節:§3.1 補反向 relation 對 migration / testcontainers / 既有 test 的零影響說明(Prisma 純 client 端概念,**不**產生 SQL DDL)。對應 spec 022 v0.3(補 TypeBox 樣板 / 共通慣例 / admin list 細節 / audit payload 樣本 / amountTwd overflow OQ) |
| 0.4 | 2026-06-15 | §3 Order 加 `note String? @db.VarChar(500)` — 訂單整單備注,非 per-line;optional,空白 trim 後若 = `""` 由 service 層轉 null。對應 spec 022 v0.4 同步擴端點 body / response / admin PATCH |
| 0.5 | 2026-06-15 | 根據 IMG_4888/4889/4890「確認捐款資訊」頁補 3 個欄位 + 1 enum:(1) `isAnonymous Boolean @default(false)` — 三類訂單共用(IMG_4890「我要匿名捐款」checkbox);(2) `receiptOption ReceiptOption?` — CHARITY/PROJECT_DONATION 必填,SALE_ITEM 必為 null(§7.5 invariant);(3) `nextChargeAt DateTime?` — RECURRING 必有,backend 算 + 存(§7.7 計算邏輯)、加 `@@index([nextChargeAt])` 未來 cron 用;(4) `ReceiptOption` enum 5 值。§10 OQ +2(收據收件資訊、cart 混合單 receiptOption)。對應 spec 022 v0.5 同步 |
| 0.6 | 2026-06-15 | §7.7 補 `nextChargeAt` 重算規約 — **只在 create 時算一次,任何 PATCH 都不重算**(confirm / cancel / admin PATCH 都不動;未來 cron 上線後由 cron 推進)。對應 spec 022 v0.6 同步補 response TypeBox 樣板 + inflated subject 欄位範圍 + 公開 GET anonymous 行為 |
| 0.7 | 2026-06-15 | §7.7 補 **Clock 注入** — `computeNextChargeAt` 為純函式,service 層不可直接 `new Date()`,production 透過 Fastify decorator `app.clock()`,test 透過 `vi.useFakeTimers` / fixed `Date`,呼應 backend CLAUDE.md。對應 spec 022 v0.7 補:(1) request body TypeBox 一律 `additionalProperties: false`;(2) admin list inflate(與 detail 一致,Prisma 一次 `include` 避 N+1);(3) `isAnonymous` 缺值 service 層 fallback `false`(不靠 Ajv `useDefaults`);(4) SALE_ITEM 帶 `receiptOption` 由 schema 層擋 → `VALIDATION_FAILED`,**移除** `RECEIPT_OPTION_NOT_APPLICABLE` error code;(5) cancel endpoint 風險納入 §2.1 風險表 |
| 0.8 | 2026-06-15 | §3 `isAnonymous` 註解釐清 — **Charity 捐款 (IMG_4888) / DonationProject 捐款 (IMG_4889) / SaleItem 購買 (IMG_4890) 三類訂單都掛「我要匿名捐款」checkbox**(原 v0.5 文字偏重 IMG_4890 易誤解為僅 SaleItem 可匿名)。code 自 v0.5 起 schema + Charity/Project/SaleItem body / service / admin list filter / admin PATCH 已全面支援(零 code 改動),本版純文件對齊。對應 spec 022 v0.9 |
