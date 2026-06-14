# 決策:Entity 生命週期欄位(soft delete / archive / scheduled publish)+ Cascading visibility 統一模式

日期:2026-06-14

## 背景

spec 015 v0.8 把三 entity(`Charity` / `DonationProject` / `SaleItem`)的資料模型定錨,但有幾個被列為**開放問題**或**out of scope**:

- 「soft delete / audit log」— 整體 backend 尚未決議
- 沒有 admin 手動排序欄位(`displayOrder` 只 Category 有)
- 沒有「上下架時間」概念
- Project / SaleItem 「下架」目前需要逐筆改

實際業務場景反證這些都不能再 defer:

1. **合約期限**:平台與公益團體是合作關係,**合作合約有期限**。合約到期時,該團體 + 旗下所有 Project / SaleItem 必須一起從公開列表消失;續約後自動恢復。
2. **募款期程**:DonationProject 截圖(IMG_4883)顯示募款專案有明確開始 / 結束日。
3. **限時義賣**:SaleItem 常見「季節商品」「週年慶限定」場景。
4. **誤刪保護 + 合規**:刪除動作要可逆且可審計,符合一般 SaaS 平台預期。
5. **admin pin / feature**:卡片列表需要「精選」「置頂」能力,不能只靠 `createdAt`。

如果讓 spec 015 / 016 / 017 各自獨立解這些需求,**會出現五種互不相容的命名**(`is_deleted` vs `deleted_at` vs `state enum` vs `visible_from` vs ...)。這個 ADR 在程式碼還沒落地、Prisma model 還沒寫之前,把命名 / 預設 filter / cascade 規則一次定錨。

## 選項評估

### 5.1 表達「已刪除 / 已封存」的方式

| 選項 | 描述 | 利 | 弊 |
|---|---|---|---|
| **`deletedAt: DateTime?` / `archivedAt: DateTime?`**(採用)| timestamp 非 null = 已刪除 / 已封存 | 同時表達**狀態** + **時間**;debug / audit / recovery 直接用;`WHERE deleted_at IS NULL` 一行擋掉 | 比 boolean 多 7 bytes / row(可忽略) |
| `deleted: Boolean` / `archived: Boolean` | 純 boolean | 4 bytes / row;mental model 直接 | 「何時刪的」需另開 audit table;一旦要做也得改 schema |
| `status: enum('active','archived','deleted')` | 單一狀態機 | 一個欄位涵蓋所有狀態 | 排他語意:archive + delete 同時發生表達不了;query 都要 `WHERE status='active'`,容易漏寫;新增狀態要 migration |

選 timestamp:**多花 7 bytes 換掉一個未來必開的 audit table**,ROI 顯而易見。

### 5.2 表達「上下架時間」的方式

| 選項 | 描述 | 評估 |
|---|---|---|
| **`publishStartAt: DateTime?` / `publishEndAt: DateTime?`**(採用)| 時間區間 nullable,null = 無限制 | 業界慣例(Shopify、Stripe Products、WordPress posts);可表達「立刻上架」「永久上架」「定時上架」「定時下架」「定時上下架」5 種組合 |
| 單一 `publishedAt: DateTime?` | 只有上架時間 | 無法表達「定時下架」;合作合約到期就無路可走 |
| `state: enum + transition timestamps` | 狀態機 | 過度設計;本作業無工作流 |

### 5.3 Cascading visibility(Parent 過期 → Children 自動隱藏)

當 Charity 的合約過期(`publishEndAt < now`)時,旗下 Project / SaleItem 該如何處理?

| 選項 | 描述 | 利 | 弊 |
|---|---|---|---|
| **Cascade in query**(採用)| Project / SaleItem list / detail query 強制 JOIN charities,parent filter 條件同時跑 | DB 強制;application 無漏網風險;狀態永遠即時(不靠定時 job) | query 多 1 個 JOIN(charityId 已有 index,代價 < 1ms) |
| Cascade in application(batch job)| 定時掃 Charity,過期就批次 set children 的 archivedAt | 看似明顯 | 多一個 job 要維護;狀態同步窗口(job 跑之前 children 還可見);續約後又要倒回去 unarchive,複雜度爆炸 |
| DB trigger | Postgres trigger 同步寫 | DB 強制 | 隱式行為難 debug;違反「business logic 不放 DB」慣例 |
| 不 cascade(各自獨立)| 合約到期但 children 仍然可見,需 admin 手動清 | 「合約到期但商品還在賣」的合規問題;admin 操作量爆炸 |

選 Cascade in query:**唯一資料來源是 query,沒有狀態同步問題**。

## 決策

### 1. 統一加 5 個 lifecycle 欄位到三個主 entity

`Charity` / `DonationProject` / `SaleItem` 各加:

```prisma
displayOrder    Int      @default(0)   // 手動排序;0 = 一般,越小越前
archivedAt      DateTime?              // 暫時下架(預期可恢復)
deletedAt       DateTime?              // soft delete(預期不恢復;合規 audit 用)
publishStartAt  DateTime?              // null = 立刻上架
publishEndAt    DateTime?              // null = 永久上架(直到手動下架)
```

`Category` 加 `archivedAt` / `deletedAt`(`displayOrder` 已存在),**不**加 publish 時間(字典表沒有合作期限語意)。

`CharityOnCategory` join 表**不**加任何 lifecycle 欄位(直接刪 join 列等於 unassign;真要追蹤指派歷史另開 audit table)。

### 2. 預設 list query filter(public 路徑)

所有公開的 list / detail endpoint **必須**套用:

```sql
WHERE deleted_at IS NULL
  AND archived_at IS NULL
  AND (publish_start_at IS NULL OR publish_start_at <= NOW())
  AND (publish_end_at   IS NULL OR publish_end_at   >  NOW())
```

把這四條件包成 service-layer 函式 `whereLive(now)`,**禁止**route handler 自己拼;讓 grep 能 100% 找到 caller。

### 3. Cascading visibility(子表必須也通過 parent 的 `whereLive`)

DonationProject / SaleItem 的所有 public 路徑 query 都必須 JOIN `charities` 並對 parent 套同一份 `whereLive`:

```sql
SELECT p.*
FROM donation_projects p
JOIN charities c ON c.id = p.charity_id
WHERE
  -- 子表自己 live
  p.deleted_at IS NULL AND p.archived_at IS NULL
  AND (p.publish_start_at IS NULL OR p.publish_start_at <= NOW())
  AND (p.publish_end_at   IS NULL OR p.publish_end_at   >  NOW())
  -- 主辦 charity 也要 live(合約 / archive / delete 任一不通過 → 子表跟著消失)
  AND c.deleted_at IS NULL AND c.archived_at IS NULL
  AND (c.publish_start_at IS NULL OR c.publish_start_at <= NOW())
  AND (c.publish_end_at   IS NULL OR c.publish_end_at   >  NOW())
```

Charity 自己的 list **不**需要 cascade(它是最上層)。

### 4. 預設排序

從 `ORDER BY createdAt DESC, id DESC` 改為:

```sql
ORDER BY display_order ASC, created_at DESC, id DESC
```

`displayOrder` 預設 0,沒手動 pin 的項目仍按 `createdAt DESC` 排;admin 想置頂只要把那筆設成負數或更小數字。

### 5. Admin 路徑(本作業 out of scope,但約定先行)

未來 admin endpoint 必須**顯式繞過**預設 filter:

```ts
// 公開路徑(預設,不能繞過)
const live = await prisma.charity.findMany({ where: whereLive(new Date()) })

// admin 路徑(需要明確的 includeArchived / includeDeleted / includeScheduled flag)
const all = await prisma.charity.findMany({
  where: whereForAdmin({ includeArchived: true, includeDeleted: false, includeScheduled: true }),
})
```

`whereForAdmin` 的回傳值與 `whereLive` 一致地由 service 層產出,**禁止** route 直接傳 raw `where`。

### 6. Hard delete 仍然存在,Restrict 仍然保留

`deletedAt = now` 是業務動作;**真的物理刪除**(`prisma.charity.delete()`)是 ops / 合規動作。後者必須:

- 通過所有 FK `onDelete: Restrict` 檢查(避免破壞外部 audit / 交易紀錄)
- 走獨立 admin endpoint,有明確 audit log
- 不在本作業 scope 內,但 schema 保留 Restrict 給未來

soft delete 不影響 FK 行為,application 層自己負責「先 soft delete 子表再 soft delete 主表」的順序(用 transaction 包)。

## 理由

### 1. 為何 timestamp 不是 boolean

「**何時刪掉的**」資訊在以下場景反覆需要:

- 客服:用戶反映「我看不到那筆專案了」→ admin 查 `deletedAt`,「2026-08-15 14:23 由 admin@xxx 刪除」立刻有答案
- 法律 / 合規:「7 年內刪除的資料要保留追溯」→ `deletedAt > now() - interval '7 years'`
- recovery:「不小心刪了,過 2 小時想救回來」→ `UPDATE SET deleted_at = NULL WHERE id = ? AND deleted_at > now() - interval '1 day'`
- 統計:「上個月刪了多少筆?」→ `COUNT WHERE deleted_at BETWEEN ...`

每一條都用 boolean 表達不出來,只能另開 audit table。**timestamp 是最簡單的 audit log**。

### 2. 為何 Cascade in query 不是 batch job

合作合約**可以續約**。如果 batch job 在合約過期那天把 200 筆子表全部 archivedAt = now,續約時又要把同 200 筆 archivedAt = null 倒回去 — 而且要分辨「這筆是 cascade 來的」vs「這筆是 admin 手動 archive 的」,不然續約會誤救手動 archive 的。複雜度爆炸。

Cascade in query 的真理只有一個來源(parent 的 `publishEndAt`),續約只動 parent,**children 自動恢復**,沒有狀態同步問題。

### 3. 為何 Charity 也要 publishStartAt / publishEndAt

第一直覺是「公益團體 = 法人實體,沒有上下架」。錯。**平台與團體之間是合作關係**:

- 合作合約簽完才開始合作(`publishStartAt = 合約生效日`)
- 合約到期未續約 → 平台停止曝光該團體(`publishEndAt = 合約結束日`)
- 未續約期間,團體**法人實體仍然存在**,只是不在我們的平台

把這當成 platform-side 的 publishing window 而非 organization-side 的 existence,語意就乾淨了。

### 4. 為何 Category 不需要 publish 時間

字典表(分類)是「**內部運營項目**」,不是合作對象。需要「暫時隱藏某個分類」用 `archivedAt`(admin 手動)已經夠;沒有「合約到期」的概念。

### 5. 為何排序欄位叫 `displayOrder` 不叫 `order`

`order` 在 SQL 是保留字,Prisma client 用起來會混 ORDER BY 語法,Search / IDE 也容易誤判。`displayOrder` 跟 spec 015 v0.5 既有 Category 命名一致,**所有 entity 統一**。

### 6. 為何 join 表(CharityOnCategory)不加 lifecycle

「指派分類」的反義是「**解除指派**」,操作上就是刪 join 列。soft-delete 一個指派的語意是「指派過但不生效」,這對檢索 / filter / 業務都沒幫助 — 業務只關心「**現在**屬不屬於某分類」。

若日後要追溯指派歷史,正解是另開 `CharityCategoryAssignmentLog` audit table,不是在 join 表硬塞 `deletedAt`。

## 後果

### 正面

- 命名與預設 filter **一次定錨**,spec 015 / 016 / 017 不會出現五種互不相容寫法
- 合作合約過期 / 續約只動 Charity **一個欄位**,旗下所有子表自動同步,**零維護**
- audit / recovery / 合規 / 客服 都直接從 timestamp 查,不必另開 audit table
- 未來新 entity(`Donation` 交易、`SaleOrder` 訂單)直接 ref 本 ADR,套同樣模式

### 負面

- 三 entity schema 各加 5 個欄位(Charity / Project / SaleItem 共 15 個欄位,Category 2 個)— 表變寬,但都是 nullable / int default 0,storage 影響 < 5%
- 所有 list / detail query 都要套 `whereLive` — 漏寫 = 安全漏洞(下架的資料被看到)。緩解:**service helper 強制走它**;測試矩陣涵蓋每個 endpoint
- Project / SaleItem 路徑都要 JOIN charities,query 多 1 個 JOIN — 已有 `charityId` index,實測 < 1ms

### 中性

- ADR 本身不規範「**admin endpoint 何時做**」,只規範「**做的時候必須走 `whereForAdmin` helper**」。Admin UI 不在本作業 scope
- 不規範 audit table。本 ADR 認定 timestamp 已涵蓋本作業需求;真出現「誰刪的」需求時再開 audit ADR

## 升級觸發

| 觸發 | 處置 |
|---|---|
| 業務要追溯「誰在何時刪掉了什麼」(actor 維度)| 新增 `Deletion` audit table:`{id, entityType, entityId, actorId, deletedAt, reason}`;`deletedAt` 仍保留為 entity 上的 marker(讀路徑無需 JOIN audit) |
| 需要「lifecycle state machine」(草稿 → 審核中 → 上架 → 下架 → 結案)| 加 `status: enum` 欄位,與 lifecycle timestamp 並存(timestamp 表「實際發生時間」,status 表「業務階段」) |
| Charity 合約變成「合約史」(可換約)| 新開 `CharityContract` table,Charity 拿掉 `publishStartAt` / `publishEndAt`,查 live 改成 `JOIN charity_contracts WHERE NOW() BETWEEN starts_at AND ends_at` |
| 三層以上 cascade(例:`SaleOrder → SaleItem → Charity`)| 同樣的 `whereLive` 在 service 抽 generic helper(`whereLive<T>(modelDelegate)`),底層遞迴跑 parent 鏈 |
| 大量過期項目拖慢 query | 加 partial index `WHERE deleted_at IS NULL AND archived_at IS NULL`(本 ADR 已建議,但等實測再建) |

## 相關文件

- spec 015 v0.9 — schema 落地、index 策略、seed 規約
- spec 016(list API)— `whereLive` 套用點與排序預設
- spec 017(detail API)— `whereLive` 套用點與 cascade visibility
- spec 018(storage)— S3 object 與 lifecycle 解耦(deleted entity 的 S3 object 由 lifecycle policy / batch job 處理,本 ADR 不涵蓋)
- ADR 001 — Project / SaleItem 對 Charity 的 1:N FK(cascading visibility 建立在這個 FK 上)
- ADR 002 — Category M:N 與「子表繼承」(本 ADR 的 cascading visibility 是「子表繼承」的時間維度延伸)
