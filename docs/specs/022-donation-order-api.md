# Spec 022:Donation Order API(public create / confirm / cancel + admin CRUD)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.7 |
| 日期 | 2026-06-15 |
| 適用範圍 | `backend/src/routes/v1/donation/orders/*`(新)、`backend/src/routes/v1/admin/orders/*`(新)、`backend/src/domain/order/*`(spec 021 共享)、`backend/src/lib/clock.ts`(spec 021 §7.7 共享) |
| 相關 ADR | 待補 |
| 相關 spec | `021-donation-order-data-model.md` v0.2(**OrderLine pattern** schema 基礎)、`020-donation-write-api.md`(admin role=0 gate)、`015-charity-data-model.md`、`005-error-handling.md`、`019-cache-policy.md`、`004-logger-module.md` |
| 設計來源 | Figma 截圖補件 IMG_4885 / 4886 / 4887,2026-06-15 |

---

## 1. 目的與範圍

### 1.1 目的

對應 spec 021 v0.2 schema(Order header + OrderLine 線項),規範訂單系統 HTTP API:
- **公開端點**(無 auth):建單、mock 結帳、user 取消、查單
- **Admin 端點**(role=0):list / detail / patch / hard delete(對齊 spec 020 §3)

**v0.2 大改**:跟著 spec 021 v0.2 採 OrderLine pattern。Response shape 由「entity FK 在 Order 上」改為「Order + lines[]」;Body shape 對 client 仍語意分明(3 個 create endpoint 各有清楚的 body 形狀,內部生成 OrderLine)。

### 1.2 In scope

- 6 個公開端點 + 4 個 admin 端點(總 10 個)
- TypeBox request / response schema(對齊 spec 021 v0.2 Order + OrderLine shape)
- Mock payment `POST /confirm-payment`
- Validation 雙層(TypeBox + service;invariant 在 spec 021 §7)
- 5 個新 error code(§7)
- Rate limit、Audit event、Integration test

### 1.3 Out of scope

- Schema → spec 021
- Domain invariant → spec 021 §7
- 真實 payment gateway → §11 OQ #1
- End-user 訂單查詢 / 取消(無 Account)→ spec 021 §1.4

---

## 2. 架構評估

### 2.1 公開端點為什麼**無 auth**

#### 決策

`POST /v1/donation/orders/*`、`POST /:id/confirm-payment`、`POST /:id/cancel`、`GET /:id` 全部無 auth。

#### 理由

- 對齊 spec 021 §2.1 訂單匿名(`donorName` 自由字串)
- 截圖無登入要求
- 「點下捐款 → 馬上填 modal → 下一步」這個 UX 不能有 auth wall

#### 風險(同 v0.1)

| 風險 | 緩解 |
|---|---|
| 自動化 POST 灌假訂單 | per-IP rate-limit;真 gateway 上線後 PENDING 沒付款自動 cancel |
| `GET /:id` 任何人查 | orderId UUIDv4 不可枚舉,「分享連結」UX |
| 隨機 POST `/confirm-payment` | mock 階段無 payment proof;真 gateway 上線後 webhook signature 擋下 |
| 任何拿到 `orderId` 的人能 POST `/cancel`(v0.7) | UUIDv4 不可枚舉視同擁有者(同 GET / confirm 邏輯);僅 PENDING 可取消(PAID → 409),最壞情況 = 取消「自己沒結帳的單」;本期 demo 接受;未來真上線需 `manageToken`(§11 OQ #2) |

### 2.2 Body shape — 三個語意 endpoint vs 一個通用 endpoint

#### 決策

維持 **3 個語意 endpoint**(charity-donation / project-donation / sale-item-purchase),body 各自有清楚的形狀;**內部**統一生成 Order + 1 OrderLine。

#### 為什麼不用一個通用 endpoint

| 選項 | 評估 |
|---|---|
| **A. 3 個語意 endpoint**(採用)| BFF / client 友善;不需了解 OrderSubjectType discriminator;OpenAPI doc 自然分離 |
| B. 1 個 `POST /v1/donation/orders` + body 含 `subjectType` | 更彈性但客戶端複雜度高;對 demo 過頭 |

未來 cart / 混合單上線時:
- 加第 4 個端點 `POST /v1/donation/orders/cart` 接受 N lines
- 或對 `/sale-item-purchase` 放寬 `items.length` 上限(本期已設 minItems=1, maxItems=1,未來改 maxItems=N)
- 既有 3 個語意 endpoint 不刪除(BFF 已習慣的呼叫)

### 2.3 Mock payment 設計(同 v0.1)

`POST /:id/confirm-payment` 把 PENDING → PAID。Idempotent on PAID(no-op)。其他狀態 → 409。

### 2.4 Admin endpoint 沿用 spec 020 樣板

- 同 path 前綴 `/v1/admin/orders/*`
- 同 `requireAdmin` preHandler(role !== 0 → 403)
- 同 per-user + per-IP rate-limit 雙層
- 訂單採 **hard delete**(spec 021 §10 OQ #7),無 archive / restore

---

## 3. 端點清單(10 個,同 v0.1)

### 3.1 公開(6 個)

| Method | Path | 用途 |
|---|---|---|
| POST | `/v1/donation/orders/charity-donation` | 對 Charity 捐款 |
| POST | `/v1/donation/orders/project-donation` | 對 DonationProject 捐款 |
| POST | `/v1/donation/orders/sale-item-purchase` | 對 SaleItem 購買 |
| POST | `/v1/donation/orders/:id/confirm-payment` | Mock 結帳:PENDING → PAID |
| POST | `/v1/donation/orders/:id/cancel` | User 取消:PENDING → CANCELLED |
| GET | `/v1/donation/orders/:id` | Detail |

### 3.2 Admin(4 個,role=0)

| Method | Path | 用途 |
|---|---|---|
| GET | `/v1/admin/orders` | List + filter(§4.7)|
| GET | `/v1/admin/orders/:id` | Detail |
| PATCH | `/v1/admin/orders/:id` | 改 status / donorName / paidAt / cancelledAt |
| DELETE | `/v1/admin/orders/:id` | Hard delete |

---

## 4. Endpoint 詳細規格

### 4.0 共通慣例(v0.3 補)

| 規約 | 值 |
|---|---|
| 日期 / 時間格式 | ISO 8601(`YYYY-MM-DDTHH:mm:ss.sssZ`),**時區一律 UTC** |
| Response 內所有 `DateTime` 欄位 | `toISOString()` 輸出,**不**含時區偏移(尾巴 `Z`) |
| `lines[]` 排序 | `createdAt ASC, id ASC`(tiebreaker);未來 cart 多 line 時保留 client 插入順序 |
| Enum source | `OrderStatus` / `OrderSubjectType` / `DonationFrequency` / `BillingDay` 一律從 `@prisma/client` import(Prisma 自動產生 TS enum;不另外維護 const) |
| Idempotency | confirm-payment / cancel 的 idempotency 在 §4.4 / §4.5;create 端點本期**無** `Idempotency-Key` 支援(§11 OQ #6)|
| Error response shape | RFC 7807(spec 005)`application/problem+json`,含 `code` 欄 |
| Request body `Type.Object` 預設(v0.7)| **一律** 設 `{ additionalProperties: false }`(strict mode);client 帶未宣告欄位 → 400 `VALIDATION_FAILED`。應用於三個 create body + admin PATCH body;Ajv 不做 `removeAdditional`(避免 silent strip)|
| Clock 來源(v0.7) | service 函式接收 `deps: { clock: () => Date }`;production 由 Fastify decorator `app.clock()` 注入,test 用 `vi.useFakeTimers` 或固定 `Date`。詳 spec 021 §7.7 |

### 4.1 `POST /v1/donation/orders/charity-donation`

```jsonc
Body {
  "donorName": "張三",                              // required, 1-120 字
  "isAnonymous": false,                              // v0.5 — optional, default false
  "note": "無名氏捐款,請勿公開",                       // optional, 0-500 字;空字串視同 null
  "receiptOption": "NONE",                          // v0.5 — CHARITY/PROJECT 必填,5 個 enum 值
  "charityId": "<uuid>",                            // required, Charity 必須 live
  "donationFrequency": "ONE_TIME" | "RECURRING",   // required
  "billingDay": "DAY_6" | "DAY_16" | "DAY_26",     // RECURRING 必設;ONE_TIME 禁設
  "amountTwd": 500                                  // required, 1 ~ 1_000_000
}

→ 201 + Location: /v1/donation/orders/<id>
{
  "id": "<uuid>",
  "status": "PENDING",
  "donorName": "張三",
  "isAnonymous": false,                              // v0.5
  "receiptOption": "NONE",                          // v0.5
  "note": "無名氏捐款,請勿公開",
  "amountTwd": 500,
  "nextChargeAt": null,                              // v0.5 — ONE_TIME 為 null;RECURRING 才有值
  "lines": [{
    "id": "<uuid>",
    "subjectType": "CHARITY",
    "charityId": "<uuid>",
    "donationProjectId": null,
    "saleItemId": null,
    "quantity": 1,
    "unitPriceTwd": 500,
    "subtotalTwd": 500,
    "donationFrequency": "ONE_TIME",
    "billingDay": null,
    "createdAt": "<ISO>",
    // v0.5 — inflated subject(對應 IMG_4888「捐款對象」/「捐款專案」顯示)
    "charity": {                                    // 因 subjectType=CHARITY 才有
      "id": "<uuid>",
      "name": "ACC 中華耆幼關懷協會",
      "logoUrl": "https://..."                      // 跑 spec 018 objectUrl(logoKey)
    },
    "donationProject": null,
    "saleItem": null
  }],
  "paidAt": null,
  "cancelledAt": null,
  "createdAt": "<ISO>",
  "updatedAt": "<ISO>"
}

錯誤:
  400 VALIDATION_FAILED       body shape 錯
  400 INVALID_BILLING_DAY     RECURRING 沒選 billingDay 或 ONE_TIME 給了
  404 CHARITY_NOT_FOUND       charityId 不存在或非 live
```

#### 內部行為

```
1. validate body (TypeBox + service-level INVALID_BILLING_DAY check)
2. findFirst Charity { id, whereLive(now) } → 404 if missing
3. transaction:
   a. Order.create { donorName, amountTwd, status: PENDING }
   b. OrderLine.create {
        orderId,
        subjectType: CHARITY,
        charityId,
        quantity: 1,
        unitPriceTwd: body.amountTwd,
        subtotalTwd: body.amountTwd,
        donationFrequency,
        billingDay,
      }
4. 重新查 Order include: { lines: true } 作為 response
5. emit pino: 'order_created' { orderId, subjectType: CHARITY }
6. → 201
```

#### TypeBox schema(v0.3 — 樣板;其他 endpoint 類比)

```ts
import { Type, type Static } from '@sinclair/typebox'

const UUID_V4 = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

export const CharityDonationBody = Type.Object({
  donorName: Type.String({ minLength: 1, maxLength: 120 }),
  // v0.5 — 三類訂單共用 isAnonymous
  isAnonymous: Type.Optional(Type.Boolean()),
  // v0.4 — 訂單備注;optional + nullable;空字串由 service 層轉 null
  note: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 500 })])),
  // v0.5 — 收據開立方式;CHARITY/PROJECT 必填(IMG_4888/4889 紅 *);SALE_ITEM 不接受(見 §5.2)
  receiptOption: Type.Union([
    Type.Literal('NONE'),
    Type.Literal('INDIVIDUAL'),
    Type.Literal('CORPORATE'),
    Type.Literal('GOVERNMENT_DONATION'),
    Type.Literal('DEFER'),
  ]),
  charityId: Type.String({ pattern: UUID_V4 }),
  donationFrequency: Type.Union([
    Type.Literal('ONE_TIME'),
    Type.Literal('RECURRING'),
  ]),
  // billingDay 在 schema 層為 optional + nullable;RECURRING ↔ billingDay 互斥
  // 約束 (§5.2) 由 service 層 throw INVALID_BILLING_DAY 接住
  billingDay: Type.Optional(
    Type.Union([
      Type.Literal('DAY_6'),
      Type.Literal('DAY_16'),
      Type.Literal('DAY_26'),
    ]),
  ),
  amountTwd: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
}, { additionalProperties: false })   // v0.7 — strict;client 帶未宣告欄位 → 400 VALIDATION_FAILED
export type CharityDonationBodyT = Static<typeof CharityDonationBody>
```

TypeBox 不能優雅表達「conditional required」(RECURRING 必設 billingDay,ONE_TIME 禁設);schema 層接受 optional,service 層 throw `INVALID_BILLING_DAY`。同 spec 008 §4.2「at-least-one identifier」的處理模式。

#### Response TypeBox 樣板(v0.6 — 共用於三個 create + GET detail + admin endpoints)

Fastify route 對 response 也走 schema validate(對齊 spec 016 / 017 既有 pattern)。三類訂單 response 共用同一個 `OrderResponse` shape(欄位齊全,各 type 透過 nullable 區分):

```ts
const ReceiptOptionUnion = Type.Union([
  Type.Literal('NONE'),
  Type.Literal('INDIVIDUAL'),
  Type.Literal('CORPORATE'),
  Type.Literal('GOVERNMENT_DONATION'),
  Type.Literal('DEFER'),
])

// inflated subject 三個 shape(v0.6 鎖定「最小集」見下)
const InflatedCharity = Type.Object({
  id: Type.String(),
  name: Type.String(),
  logoUrl: Type.Union([Type.Null(), Type.String()]),
})
const InflatedDonationProject = Type.Object({
  id: Type.String(),
  name: Type.String(),
  charity: InflatedCharity,                      // parent
})
const InflatedSaleItem = Type.Object({
  id: Type.String(),
  name: Type.String(),
  priceTwd: Type.Integer(),
  charity: InflatedCharity,                      // parent
})

const OrderLineResponse = Type.Object({
  id: Type.String(),
  subjectType: Type.Union([
    Type.Literal('CHARITY'),
    Type.Literal('DONATION_PROJECT'),
    Type.Literal('SALE_ITEM'),
  ]),
  charityId: Type.Union([Type.Null(), Type.String()]),
  donationProjectId: Type.Union([Type.Null(), Type.String()]),
  saleItemId: Type.Union([Type.Null(), Type.String()]),
  quantity: Type.Integer(),
  unitPriceTwd: Type.Integer(),
  subtotalTwd: Type.Integer(),
  donationFrequency: Type.Union([
    Type.Null(),
    Type.Literal('ONE_TIME'),
    Type.Literal('RECURRING'),
  ]),
  billingDay: Type.Union([
    Type.Null(),
    Type.Literal('DAY_6'), Type.Literal('DAY_16'), Type.Literal('DAY_26'),
  ]),
  createdAt: Type.String({ format: 'date-time' }),
  // Inflated subjects — 互斥,只有對應 subjectType 那欄非 null
  charity: Type.Union([Type.Null(), InflatedCharity]),
  donationProject: Type.Union([Type.Null(), InflatedDonationProject]),
  saleItem: Type.Union([Type.Null(), InflatedSaleItem]),
})

export const OrderResponse = Type.Object({
  id: Type.String(),
  status: Type.Union([
    Type.Literal('PENDING'), Type.Literal('PAID'),
    Type.Literal('CANCELLED'), Type.Literal('FAILED'), Type.Literal('REFUNDED'),
  ]),
  donorName: Type.String(),
  isAnonymous: Type.Boolean(),
  receiptOption: Type.Union([Type.Null(), ReceiptOptionUnion]),
  note: Type.Union([Type.Null(), Type.String()]),
  amountTwd: Type.Integer(),
  nextChargeAt: Type.Union([Type.Null(), Type.String({ format: 'date-time' })]),
  lines: Type.Array(OrderLineResponse),
  paidAt: Type.Union([Type.Null(), Type.String({ format: 'date-time' })]),
  cancelledAt: Type.Union([Type.Null(), Type.String({ format: 'date-time' })]),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
})
export type OrderResponseT = Static<typeof OrderResponse>
```

Fastify 註冊:

```ts
app.route<{ Body: CharityDonationBodyT }>({
  method: 'POST',
  url: '/v1/donation/orders/charity-donation',
  schema: {
    body: CharityDonationBody,
    response: { 201: OrderResponse },
  },
  handler: async (req, reply) => { /* ... */ },
})
```

#### Inflated subject 的欄位範圍(v0.6 鎖定)

| 欄位來源 | 對應 IMG | 包含欄位 | 為什麼不包含其他 spec 017 detail 全欄 |
|---|---|---|---|
| `Charity` | IMG_4888「捐款對象」| `id` / `name` / `logoUrl` | confirmation 頁不需要 description / contactPhone / categories 等 spec 017 detail 欄;包進來會讓 response 變肥(平均 +3-5 KB),cache 命中率也不一樣 |
| `DonationProject` | IMG_4889「捐款專案」 | `id` / `name` + parent `charity` 同上 | 同上,不含 content / coverImageUrl 等 |
| `SaleItem` | IMG_4890「商品」 | `id` / `name` / `priceTwd` + parent `charity` | 同上,不含 content / coverImageUrl |

如果未來 UI 需要更多欄位,評估是否走 expand 模式(`?include=charity.description`),但本期不做。

### 4.2 `POST /v1/donation/orders/project-donation`

同 4.1,把 `charityId` 換 `donationProjectId`、`subjectType: DONATION_PROJECT`、`whereLiveWithParent` 驗證(parent Charity 也 live)。`note` / `isAnonymous` / `receiptOption` / `nextChargeAt` 同 4.1 處理。

#### Response 的 inflated subject(對應 IMG_4889「捐款專案」「捐款對象」)

```jsonc
"lines": [{
  ...,
  "charity": null,
  "donationProject": {
    "id": "<uuid>",
    "name": "偏鄉AI數位學習計畫 - 給孩子一雙探索未來的雙手",  // IMG_4889「捐款專案」
    "charity": {                                              // parent inflate(IMG_4889「捐款對象」)
      "id": "<uuid>",
      "name": "財團法人菩提社會福利慈善事業基金會"
    }
  },
  "saleItem": null
}]
```

### 4.3 `POST /v1/donation/orders/sale-item-purchase`

**TypeBox 慣例(v0.7)**:`SaleItemPurchaseBody` 同樣設 `additionalProperties: false`(對齊 §4.0)。若 client 誤帶 `receiptOption` / `donationFrequency` / `billingDay` / `charityId` 等捐款專屬欄位 → 400 `VALIDATION_FAILED`(由 schema 層擋,不走 service 自定錯誤)。

> v0.5 曾規劃 `RECEIPT_OPTION_NOT_APPLICABLE` 自定 error code 由 service 層擋,v0.7 改由 schema 層統一擋:理由 (1) 更早 fail;(2) 避免雙層校驗;(3) Ajv 錯誤訊息已可定位「unknown property: receiptOption」,client 體驗夠明確。`RECEIPT_OPTION_NOT_APPLICABLE` 從 §7 error code 表移除。


```jsonc
Body {
  "donorName": "張三",
  "isAnonymous": false,                              // v0.5 — optional, default false(IMG_4890 checkbox)
  "note": "請放門口,謝謝",                            // optional, 0-500 字
  // 注意:SALE_ITEM_PURCHASE 無 receiptOption(IMG_4890 沒此 dropdown);body 不接受
  "items": [
    {
      "saleItemId": "<uuid>",                       // required, live
      "quantity": 1                                  // required, 1 ~ 100
    }
    // 本期 items 必須剛好 1 個(對應 IMG_4887 單品 UI)
    // 未來支援 cart 時放寬 maxItems
  ]
}

→ 201 + Location: /v1/donation/orders/<id>
{
  "id": "<uuid>",
  "status": "PENDING",
  "donorName": "張三",
  "isAnonymous": false,                              // v0.5
  "receiptOption": null,                             // v0.5 — SALE_ITEM 永遠 null
  "note": "請放門口,謝謝",
  "amountTwd": 898,                                 // = sum(lines[].subtotalTwd)
  "nextChargeAt": null,                              // v0.5 — SALE_ITEM 永遠 null
  "lines": [{
    "id": "<uuid>",
    "subjectType": "SALE_ITEM",
    "charityId": null,
    "donationProjectId": null,
    "saleItemId": "<uuid>",
    "quantity": 2,
    "unitPriceTwd": 449,                            // SaleItem.priceTwd 建單時 snapshot
    "subtotalTwd": 898,
    "donationFrequency": null,
    "billingDay": null,
    "createdAt": "<ISO>",
    "charity": null,
    "donationProject": null,
    // v0.5 — inflated SaleItem(對應 IMG_4890 「商品」「團體」顯示)
    "saleItem": {
      "id": "<uuid>",
      "name": "陸仕私廚 藤椒牛肉麵 760g",
      "priceTwd": 449,
      "charity": {                                  // SaleItem 主辦團體(IMG_4890「團體」)
        "id": "<uuid>",
        "name": "財團法人台灣紅絲帶基金會"
      }
    }
  }],
  ...
}

錯誤:
  400 VALIDATION_FAILED
  400 ORDER_LINES_REQUIRED     items 為空
  400 ORDER_TOO_MANY_LINES     items 長度 > 1(本期)
  404 SALE_ITEM_NOT_FOUND      saleItemId 不存在或非 live
```

#### 內部行為

```
1. validate body
2. 對 items 內每筆:findFirst SaleItem { id, whereLiveWithParent(now) } → 404
3. transaction:
   a. 算 amountTwd = sum(quantity × SaleItem.priceTwd)
   b. Order.create { donorName, amountTwd, status: PENDING }
   c. 對 items 內每筆 OrderLine.create {
        subjectType: SALE_ITEM,
        saleItemId,
        quantity,
        unitPriceTwd: SaleItem.priceTwd (snapshot),
        subtotalTwd: quantity × unitPriceTwd,
      }
4. 查 Order include: { lines: true }
5. emit pino: 'order_created' { orderId, subjectType: SALE_ITEM, lineCount }
6. → 201
```

### 4.4 `POST /v1/donation/orders/:id/confirm-payment`

```
無 body

成功:
  Order.status: PENDING → PAID
  Order.paidAt = NOW()
  → 200 + 完整 order body

Idempotent:
  PAID     → 200 + body(no-op)
  CANCELLED → 409 ORDER_STATUS_INVALID
  FAILED   → 409
  REFUNDED → 409
```

### 4.5 `POST /v1/donation/orders/:id/cancel`

```
無 body

成功:
  Order.status: PENDING → CANCELLED
  Order.cancelledAt = NOW()
  → 200 + 完整 order body

Idempotent:
  CANCELLED → 200 + body
  PAID      → 409(已付款不能 user-cancel,需 admin REFUNDED)
  FAILED    → 409
  REFUNDED  → 409
```

### 4.6 `GET /v1/donation/orders/:id`

```
→ 200 + 完整 order body(Response shape 同 §4.1 `OrderResponse`)
  404 ORDER_NOT_FOUND

無 auth — UUIDv4 不可枚舉。
```

#### `isAnonymous` 對 response 的影響(v0.6 補)

**Backend 一律回原樣**:`donorName` / `isAnonymous` / `note` 全部完整 echo,**不**做 server-side masking。

理由:
- 持有 `orderId`(UUID 不可枚舉)視同訂單擁有者,看自己訂單的 donorName 是合理 UX
- Admin 端(`/v1/admin/orders/:id`)同樣回完整資料 — 法規 / 收據處理需要
- 「捐款者列表」這類 public-facing 場景(假設未來 charity detail 頁顯示「最近捐款者」)的 anonymization 由 **BFF / UI 端**依 `isAnonymous` 顯示「匿名捐款者」即可,backend 不對外重複規範

`isAnonymous` 在 backend 純粹是「標記資料」,**沒有任何 read endpoint 因為它而改 response shape**。

### 4.7 `GET /v1/admin/orders`(admin)

```
Query string:
  ?status=PENDING | PAID | CANCELLED | FAILED | REFUNDED   # Order header 層
  ?subjectType=CHARITY | DONATION_PROJECT | SALE_ITEM      # 篩 line 上的 subjectType
  ?charityId=<uuid>                                         # 篩 line 引用此 charity
  ?donationProjectId=<uuid>                                 # 同上 project
  ?saleItemId=<uuid>                                        # 同上 sale-item
  ?isAnonymous=true|false                                   # v0.5 — 篩匿名訂單
  ?receiptOption=NONE|INDIVIDUAL|...                        # v0.5 — 篩收據類型
  ?dateFrom=<ISO> ?dateTo=<ISO>                             # Order.createdAt 區間
  ?cursor=<opaque>                                          # 上一頁的 nextCursor
  ?limit=10                                                 # default 10, max 50

→ 200 + paginated envelope:
  {
    "items": [Order(含 lines), ...],
    "pageInfo": { "nextCursor": "<opaque> | null", "hasMore": bool }
  }
```

注意 v0.2 沒有 `?type=`(因 Order 不再帶 type discriminator;改 `?subjectType=` 走 OrderLine join)。

#### Response inflate 行為(v0.7)

list 回傳的 `items[]` 每個 Order **與 detail 完全相同 shape**(`OrderResponse`);`lines[]` 同樣帶 `charity` / `donationProject` / `saleItem` inflate 欄(IMG_4888 / 4889 / 4890 對齊)。Prisma query **一次 `include`** 帶下,避免 N+1:

```ts
prisma.order.findMany({
  where: { /* filters */ },
  include: {
    lines: {
      include: {
        charity: { select: { id: true, name: true, logoKey: true } },
        donationProject: {
          select: {
            id: true, name: true,
            charity: { select: { id: true, name: true, logoKey: true } },
          },
        },
        saleItem: {
          select: {
            id: true, name: true, priceTwd: true,
            charity: { select: { id: true, name: true, logoKey: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    },
  },
  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  take: limit + 1,
})
```

`logoKey` → `logoUrl` 由 service 層走 spec 018 `objectUrl()` 轉(batch 一次轉所有 line 的 logoKey,避免 per-line round trip)。同 logic 套用於 detail / GET 公開 endpoint。

#### 多 filter 語意(v0.3 補)

| 規則 | 細節 |
|---|---|
| **Header filter(`status` / `dateFrom` / `dateTo`)** | 直接 `WHERE` Order 表 |
| **Line filter(`subjectType` / `charityId` / `donationProjectId` / `saleItemId`)**| 同一個 line 必須 match **所有** line-level filter(AND on **same** line) |
| 多 filter 組合 | 全部 AND;例:`?status=PAID&subjectType=CHARITY&charityId=X` = 「Order 是 PAID 且**有一條 line** subjectType=CHARITY 且 charityId=X」 |
| `?subjectType=CHARITY&saleItemId=Y` | **可能空集合**(同一 line 不可能既是 charity 又是 sale-item;本期 1 line per order 永遠空) |

SQL 表達(Postgres):

```sql
SELECT o.* FROM orders o
 WHERE o.status = $1
   AND o.created_at >= $2 AND o.created_at < $3
   AND EXISTS (
     SELECT 1 FROM order_lines l
      WHERE l.order_id = o.id
        AND l.subject_type = $4
        AND l.charity_id = $5    -- 同一 line 上 AND
   )
 ORDER BY o.created_at DESC, o.id DESC
 LIMIT $6
```

#### Date filter 邊界

- 含義:`dateFrom ≤ Order.createdAt < dateTo`(**下含上不含**,半開區間,對齊 SQL `[)` 慣例)
- 都接受 ISO 8601;時區一律 UTC(§4.0)
- 兩者皆 optional(只給 `dateFrom` = 從該時間到現在;只給 `dateTo` = 從最早到該時間)

#### Cursor 形狀

- 對齊 spec 016 §4.5 pattern;Order 沒有 `displayOrder`,所以排序鍵 = `(createdAt DESC, id DESC)`
- `nextCursor` = base64url(`{ lastCreatedAt: ISO, lastId: UUID }`)
- WHERE tiebreaker:`(created_at, id) < (lastCreatedAt, lastId)`(lexicographic,對應 DESC 排序的「下一頁」)

### 4.8 `GET /v1/admin/orders/:id`

```
→ 200 + 完整 order body(同 4.6,但需 requireAdmin)
  404 ORDER_NOT_FOUND
  403 FORBIDDEN(role ≠ 0)
```

### 4.9 `PATCH /v1/admin/orders/:id`(admin)

```jsonc
Body {
  "status": OrderStatus,                  // optional, 合法任一值
  "donorName": "...",                     // optional
  "isAnonymous": true | false,             // v0.5 — optional
  "note": "..." | null,                    // optional, 0-500 字;null 清空
  "receiptOption": ReceiptOption | null,   // v0.5 — optional;null 清空(僅 SALE_ITEM 訂單允許)
  "paidAt": "<ISO>" | null,                // optional
  "cancelledAt": "<ISO>" | null            // optional
}

禁止改:id, amountTwd, nextChargeAt, lines, createdAt, updatedAt
     (lines 不能改是因為「訂單成立後不可更動內容」是會計常規;若需改要 DELETE + 重建)
     (nextChargeAt 為 derived,管理員不直接改;若要重算需先改 line.billingDay 但本期 line immutable)

→ 200 + 完整 order body
```

### 4.10 `DELETE /v1/admin/orders/:id`(admin)

```
無 body

成功:
  hard delete Order(Cascade 刪 OrderLine)
  → 204

錯誤:
  404 ORDER_NOT_FOUND
  403 FORBIDDEN
```

---

## 5. Validation rules

### 5.1 TypeBox 層(route)

| 欄位 | 約束 |
|---|---|
| `donorName` | minLength 1, maxLength 120 |
| `isAnonymous`(v0.5)| optional, boolean, default false |
| `note`(v0.4)| optional + nullable;有值 maxLength 500;`Type.Union([Type.Null(), Type.String({ maxLength: 500 })])` |
| `receiptOption`(v0.5)| CHARITY/PROJECT body **必填**(enum literal union 5 值);SALE_ITEM body **不接受**(由 §5.2 service 層擋)|
| `charityId` / `donationProjectId` / `saleItemId` | UUID v4 pattern |
| `donationFrequency` | enum literal union |
| `billingDay` | enum literal union |
| `amountTwd` | int, 1 ~ 1_000_000 |
| `items[].quantity` | int, 1 ~ 100 |
| `items` length | minItems 1, maxItems 1(本期) |
| **Root `Type.Object` 策略(v0.7)** | **所有** body schema(三 create + admin PATCH)一律 `additionalProperties: false`;client 帶未宣告欄位 → 400 `VALIDATION_FAILED`(取代 v0.5 規劃的 service 層 `RECEIPT_OPTION_NOT_APPLICABLE`)|

### 5.2 Service 層

| 規則 | 動作 |
|---|---|
| `donationFrequency=RECURRING` 沒帶 `billingDay` | INVALID_BILLING_DAY(400) |
| `donationFrequency=ONE_TIME` 帶了 `billingDay` | 同上 |
| FK lookup 失敗 | *_NOT_FOUND(404) |
| `items` 長度 > 1 | ORDER_TOO_MANY_LINES(400) |
| Status transition 不合法 | ORDER_STATUS_INVALID(409) |
| `note` 為空字串或全空白(v0.4,v0.7 釐清落點)| **service 層** trim:`const trimmed = body.note?.trim(); const note = trimmed === '' || trimmed == null ? null : trimmed`。TypeBox 不擋空字串(允許 `Type.String({ maxLength: 500 })` minLength 預設 0);避免 `""` 與 `null` 兩種「無備注」狀態並存 |
| `isAnonymous` 省略(v0.7)| **service 層** fallback `body.isAnonymous ?? false`;**不**依賴 Ajv `useDefaults`(降低設定依賴 + 行為對 TDD 一目了然) |
| `nextChargeAt` 計算(v0.5,RECURRING 才算)| 依 spec 021 §7.7 公式 — 由 service 層算 + 進 transaction 寫進 DB;`now` 經 `deps.clock()` 注入(v0.7),不在 service 內 `new Date()` |

### 5.3 Domain 層(invariant)

→ spec 021 §7。違反 = 程式 bug,500。

---

## 6. Cache strategy

訂單**完全不進 cache**(對齊 spec 019 §3.2)。

未來如實測 admin list 高頻,加 cache 走 spec 019 同 pattern。

---

## 7. Error codes(新增 5 個)

| Code | HTTP | 場景 |
|---|---|---|
| `INVALID_BILLING_DAY` | 400 | RECURRING 沒選 billingDay,或 ONE_TIME 給了 |
| `ORDER_LINES_REQUIRED` | 400 | SALE_ITEM_PURCHASE 沒帶 items 或空陣列 |
| `ORDER_TOO_MANY_LINES` | 400 | items / lines 長度 > 本期上限(1) |
| `ORDER_NOT_FOUND` | 404 | orderId 不存在 |
| `ORDER_STATUS_INVALID` | 409 | confirm / cancel 起始 status 錯,或 admin PATCH 違反 |

沿用既有:`VALIDATION_FAILED`、`CHARITY_NOT_FOUND`、`DONATION_PROJECT_NOT_FOUND`、`SALE_ITEM_NOT_FOUND`、`FORBIDDEN`。

> **v0.1 → v0.2 更名**:`ORDER_ITEMS_REQUIRED` → `ORDER_LINES_REQUIRED`、`ORDER_TOO_MANY_ITEMS` → `ORDER_TOO_MANY_LINES`(配合 schema 把 OrderItem 改名 OrderLine)。
>
> **v0.7 移除**:`RECEIPT_OPTION_NOT_APPLICABLE`(v0.5 引入) — SALE_ITEM body 帶 `receiptOption` 改由 TypeBox `additionalProperties: false` 在 schema 層擋 → 400 `VALIDATION_FAILED`,避免雙層校驗(見 §4.3 / §5.1)。

---

## 8. Rate limit

### 8.1 公開

| 端點群 | per-IP |
|---|---|
| 3 個 create | 30 / hour |
| confirm-payment / cancel | 60 / hour |
| GET detail | 300 / hour |

### 8.2 Admin

對齊 spec 020 §11 雙層:

| 端點群 | per-User | per-IP |
|---|---|---|
| GET list | 600 / hour | 1200 / hour |
| GET detail | 1200 / hour | 2400 / hour |
| PATCH / DELETE | 60 / hour | 300 / hour |

---

## 9. Audit

| Event | 觸發 | level | audit |
|---|---|---|---|
| `order_created` | 三個 create 成功 | info | ✅ |
| `order_payment_confirmed` | confirm-payment 實際改 PAID | info | ✅ |
| `order_cancelled` | cancel 實際改 CANCELLED | info | ✅ |
| `order_admin_patched` | admin PATCH 成功 | info | ✅ |
| `order_admin_deleted` | admin DELETE 成功 | warn | ✅ |

### 9.1 Payload 樣本(v0.3 補)

```jsonc
// order_created — 三個 create endpoint 共用
{ "event": "order_created", "orderId": "<uuid>", "subjectType": "CHARITY" | "DONATION_PROJECT" | "SALE_ITEM",
  "lineCount": 1, "reqId": "<uuid>", "audit": true }

// order_payment_confirmed — confirm-payment 「實際改 PAID」(idempotent no-op 不發)
{ "event": "order_payment_confirmed", "orderId": "<uuid>", "reqId": "<uuid>", "audit": true }

// order_cancelled — cancel 「實際改 CANCELLED」(idempotent no-op 不發)
{ "event": "order_cancelled", "orderId": "<uuid>", "reqId": "<uuid>", "audit": true }

// order_admin_patched — 含 statusBefore / statusAfter(若 status 有改)
{ "event": "order_admin_patched", "orderId": "<uuid>", "accountId": "<admin uuid>",
  "statusBefore": "PENDING", "statusAfter": "PAID",
  "fieldsChanged": ["status", "paidAt"],
  "reqId": "<uuid>", "audit": true }

// order_admin_deleted — warn 級
{ "event": "order_admin_deleted", "orderId": "<uuid>", "accountId": "<admin uuid>",
  "reqId": "<uuid>", "audit": true }
```

### 9.2 禁含欄位

**禁止**含:`donorName`、`amountTwd`、`unitPriceTwd`、任何 line 細節(會計數據需要時從 DB 查)。對應 spec 004 §7.1 redact policy。

---

## 10. Test strategy(integration)

### 10.1 必驗 case

| Case | 範例 |
|---|---|
| Create CHARITY_DONATION ONE_TIME | 201 + Order + 1 OrderLine + line.subjectType=CHARITY + line.donationFrequency=ONE_TIME + line.billingDay=null |
| Create CHARITY_DONATION RECURRING | + line.billingDay=DAY_26 |
| Create RECURRING 沒 billingDay | 400 `INVALID_BILLING_DAY` |
| Create ONE_TIME 帶 billingDay | 400 `INVALID_BILLING_DAY` |
| Create PROJECT_DONATION cascading dead parent | parent expired → 404 |
| Create SALE_ITEM_PURCHASE 1 item | 201 + line.subtotalTwd = qty × snapshot + Order.amountTwd = line.subtotal |
| Create SALE_ITEM_PURCHASE empty items | 400 `ORDER_LINES_REQUIRED` |
| Create SALE_ITEM_PURCHASE 2 items | 400 `ORDER_TOO_MANY_LINES` |
| Create SaleItem 不存在 | 404 |
| Confirm PENDING | → PAID + paidAt 設定 |
| Confirm PAID(idempotent) | → 200 no-op |
| Confirm CANCELLED | → 409 |
| Cancel PENDING | → CANCELLED + cancelledAt 設定 |
| Cancel PAID | → 409 |
| GET /:id 不存在 | 404 |
| GET /:id 任何人(無 auth) | 200 |
| Admin GET list filter by subjectType=CHARITY | 結果只含 line 引用 charity 的 |
| Admin GET list filter by charityId | 結果只含 line 引用此 charity |
| Admin GET list pagination cursor | 對齊 spec 016 cursor 行為 |
| Admin PATCH status | 200 |
| Admin PATCH non-admin | 403 |
| Admin DELETE | 204 + Order 不存在 + OrderLine Cascade 清 |
| Admin DELETE non-admin | 403 |
| **v0.5** Create CHARITY 沒帶 receiptOption | 400 `VALIDATION_FAILED`(TypeBox required) |
| **v0.5** Create SALE_ITEM 帶 receiptOption(v0.7 改) | 400 `VALIDATION_FAILED`(TypeBox `additionalProperties: false` schema 層擋;不再走 `RECEIPT_OPTION_NOT_APPLICABLE`)|
| **v0.7** Create CHARITY 帶未宣告欄位(如 `foo: "bar"`)| 400 `VALIDATION_FAILED`(strict body 拒所有 unknown property)|
| **v0.7** Create RECURRING `nextChargeAt` 邊界 — clock 注入 fixed `2026-06-15T08:00:00Z` | `nextChargeAt` = `2026-06-16T00:00:00.000Z`(`billingDay=DAY_16`);clock 改 `2026-06-16T08:00:00Z` → `2026-07-16T00:00:00.000Z` |
| **v0.7** Admin list `?charityId=X` 回傳 `lines[].charity` inflate 完整 | response 含 `id` / `name` / `logoUrl`(走 spec 018 `objectUrl()`)|
| **v0.5** Create RECURRING(billingDay=DAY_16,今天 6/15) | response.nextChargeAt = "2026-06-16T00:00:00.000Z" |
| **v0.5** Create RECURRING(billingDay=DAY_16,今天 6/16) | response.nextChargeAt = "2026-07-16T00:00:00.000Z"(當天視為已過)|
| **v0.5** Create ONE_TIME(任何 subjectType)| response.nextChargeAt = null |
| **v0.5** Create with isAnonymous=true | DB row 寫入 true + response 回傳 true |
| **v0.5** Create with isAnonymous 缺(default)| DB row 寫入 false |
| **v0.5** Response 含 inflated subject(charity / project + parent / saleItem + parent)| 對應 IMG_4888/4889/4890 顯示資料 |
| **v0.5** Admin list `?isAnonymous=true` | 結果只含匿名訂單 |

合計約 33 ~ 40 個 integration test(v0.5 新加 8 個 + v0.7 新加 3 個邊界 case)。

### 10.2 不測試

- Prisma migration 行為
- Domain invariant 失敗(屬程式 bug,unit test 已覆)

---

## 11. Open questions(API-only)

| # | 問題 | 暫定方向 |
|---|---|---|
| 1 | 真實 payment gateway | Stripe / Line Pay / 街口;ADR + webhook + secrets;本期不做 |
| 2 | End-user 訂單查詢 / 取消(無 Account) | donorEmail + manageToken 寄信流程;本期不做 |
| 3 | Cart(SaleItem 多品)+ 混合單(donation + sale-item 同單)| 放寬 SALE_ITEM_PURCHASE 的 items maxItems;或加 `POST /cart` endpoint 接受 mixed lines;schema 已 future-proof,只需放寬端點 |
| 4 | 退款 / 部分退款 endpoint | admin PATCH `status=REFUNDED` 已可表達整單退;部分退款需 `RefundLine` 子表(對應 spec 021 OQ #3) |
| 5 | 訂單收據 / 確認信 | 無寄信能力 |
| 6 | `Idempotency-Key` header | confirm / cancel 已有 status idempotency;create 訂單沒;本期不做 |
| 7 | OpenAPI 文件 | spec 016 §12.1 v0.13 `openapiPlugin` 自動 walk |
| 8 | Admin list 加 cache | 等實測流量;走 spec 019 同 pattern |
| 9 | 加新 OrderSubjectType(EventTicket 等) | schema 已準備好 — OrderLine 加 FK + enum value,然後新 endpoint 走同套 service 樣板 |
| 10 | `amountTwd` 上限與 BigInt 升級 | 本期單 line 上限 100 × 1_000_000 = 100M;Prisma `Int` 上限 2.1B,5 line cart 內安全。**未來** cart 開放後 >20 line 可能逼近,屆時 Order.amountTwd / OrderLine.subtotalTwd 升級 `BigInt` migration |

---

## 12. Phasing(spec → code 階段)

| Phase | 內容 | 工時估 |
|---|---|---|
| **Phase 0** | spec 021 + 022 v0.2 merge + ADR 013 評估 | — |
| **Phase 1**(spec 021) | Schema + migration + 4 enum + Charity / Project / SaleItem 反向 relation | ~3 hr |
| **Phase 2**(本 spec) | `order/create-services.ts`(三個 create + transaction + line 構造)+ 3 個 create endpoint + tests | ~6 hr(略多於 v0.1 的 5 hr,因為 OrderLine 構造 transactional logic 多)|
| **Phase 3**(本 spec) | `lifecycle-services.ts` + confirm-payment / cancel + GET detail + tests | ~3 hr |
| **Phase 4**(本 spec) | Admin endpoints(list / detail / patch / hard delete)+ tests | ~4 hr |
| **Phase 5** | spec v0.3 收筆 + OpenAPI 驗證 | ~2 hr |

**總計約 18 小時**(比 v0.1 多 1 hr,符合 OrderLine pattern 的複雜度溢出)。

---

## 13. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-15 | 初版(從 021-donation-order-api.md 拆出 API 部分) |
| 0.2 | 2026-06-15 | 跟隨 spec 021 v0.2 改 OrderLine pattern:Response shape 由「Order 直接帶 entity FK」改為「Order + lines[]」;3 個 create endpoint body shape 不變(語意分明),內部生成 Order + 1 OrderLine;admin list 的 `?type=` 改 `?subjectType=`(走 OrderLine join);error code `ORDER_ITEMS_*` 改名 `ORDER_LINES_*`;Phase 2 工時 +1 hr(transactional line 構造) |
| 0.3 | 2026-06-15 | 補可開發性細節:§4.0 共通慣例(日期 UTC / ISO 8601、`lines[]` 排序、enum 來源、Idempotency-Key 缺、error 用 RFC 7807);§4.1 補 TypeBox schema 完整 code 樣板(charity-donation 為錨);§4.7 補 admin list 多 filter 語意(line-level filter AND on same line)+ SQL 範例 + date filter 半開區間 + cursor 形狀(`(createdAt DESC, id DESC)` + base64url encode);§9.1 補 5 個 audit event 的完整 payload 樣本(`order_admin_patched` 加 `fieldsChanged` 陣列);§11 OQ 加 #10「`amountTwd` 上限與 BigInt 升級」(本期安全,cart 開放後逼近 Int 上限再升)。本 spec 引用 spec 021 v0.3 的反向 relation 說明 |
| 0.4 | 2026-06-15 | 加 `note` 欄位(訂單備注,整單共用,optional 0-500 字):§4.1 charity-donation body + response 範例加 `note`;§4.1 TypeBox 樣板補對應 `Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 500 })]))`;§4.2 / §4.3 同步引用;§4.9 admin PATCH 加入可改欄位;§5.1 / §5.2 補對應 validation rule(空字串 / 全空白 trim 後轉 null,避免 `""` 與 `null` 兩種「無備注」並存)。對應 spec 021 v0.4 新加 `Order.note String? @db.VarChar(500)` |
| 0.5 | 2026-06-15 | 根據 IMG_4888 / 4889 / 4890「確認捐款資訊」頁補:(1) `isAnonymous`(三類訂單共用,Boolean default false);(2) `receiptOption`(CHARITY/PROJECT 必填,5 enum 值,SALE_ITEM 不接受 → 400 `RECEIPT_OPTION_NOT_APPLICABLE`);(3) `nextChargeAt`(RECURRING derived,backend 算 + 存,non-PATCHable)。§4.1 / §4.3 body + response 範例擴;§4.1 TypeBox 補;§4.2 補 project response 含 `donationProject + parent charity` inflate(IMG_4889);§4.3 補 SaleItem response 含 `saleItem + parent charity` inflate(IMG_4890);§4.7 admin filter 加 `?isAnonymous=` `?receiptOption=`;§4.9 admin PATCH 允許 `isAnonymous` / `receiptOption`(SALE_ITEM 限);§5.1 / §5.2 補對應約束;§7 補 1 新 error code;§10 +8 test case。對應 spec 021 v0.5 |
| 0.6 | 2026-06-15 | 收尾「足夠開發」的最後 4 個細節:(1) §4.1 補完整 **Response TypeBox 樣板**(`OrderResponse` / `OrderLineResponse` / `InflatedCharity` / `InflatedDonationProject` / `InflatedSaleItem`)+ Fastify route 註冊範例;(2) §4.1 鎖 **inflated subject 欄位範圍**(對齊 IMG_4888-4890 最小集,不含 spec 017 detail 全欄;附理由表);(3) §4.6 補 **`isAnonymous` 對 response 的影響** — backend 一律回原樣,masking 責任在 BFF / UI;(4) 對應 spec 021 v0.6 §7.7 補 `nextChargeAt` 不重算規約 |
| 0.7 | 2026-06-15 | 補 6 個最佳實踐落點(回應「足夠開發?」review):(1) §4.0 共通慣例 + §5.1 規約 **所有 request body `Type.Object` 設 `additionalProperties: false`**(strict mode,拒未宣告欄位);(2) §4.0 + spec 021 §7.7 規範 **Clock 注入**:service 接收 `deps.clock: () => Date`,production 從 Fastify decorator,test 用 `vi.useFakeTimers` / fixed Date;(3) §4.7 補 **admin list inflate 行為** — 與 detail 同 shape,Prisma 一次 `include` 帶 charity/project/saleItem 避 N+1,logoKey → logoUrl batch 過 spec 018;(4) §5.2 釐清 **`isAnonymous` 缺值 service 層 fallback `false`**(不依賴 Ajv `useDefaults`);(5) §5.2 釐清 **`note` trim 落點 = service 層**;(6) §2.1 風險表補 **cancel endpoint 風險**(任何拿 orderId 者可 cancel,本期接受 UUID 視同擁有者,未來改 manageToken)。**移除** `RECEIPT_OPTION_NOT_APPLICABLE` error code(v0.5 加,v0.7 改由 schema 層擋成 `VALIDATION_FAILED`,避免雙層校驗);§10 新加 3 個 integration test case(unknown property / clock 邊界 / admin list inflate)。對應 spec 021 v0.7 |
