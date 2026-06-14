# 決策:DonationProject 與 SaleItem 對 Charity 採 1:N NOT NULL FK 關聯

日期:2026-06-14

## 背景

`backend/` 的「捐款項目」domain 有三個 entity,對應 Figma 三個 tab:

- **Charity**(公益團體) — 法人組織,實際做公益的主體
- **DonationProject**(捐款專案) — 某團體發起的募款活動
- **SaleItem**(義賣商品) — 某團體賣的商品,收入歸該團體

需要決定三 entity 之間的關聯結構與 FK 約束。在 spec 015 / 016 草擬過程中,「是否關聯、如何關聯」反覆討論了三次(獨立 → FK → 獨立 → FK),代價是每次反轉都要連動修改 schema / migration / seed / API / test。本 ADR 正式定錨,避免後續再次翻案。

## 選項評估

| 選項 | 描述 | 利 | 弊 |
|---|---|---|---|
| **1:N + `charityId` NOT NULL FK + `onDelete: Restrict`**(採用)| Project / SaleItem 各 `belongs to` 一個 Charity,FK 必填,刪 Charity 受 Restrict 擋下 | 語意正確;查詢免 null check;Charity 誤刪受保護;Prisma 型別最乾淨 | Charity 刪除需先清子表(MVP 無此操作影響可忽略) |
| 1:N + nullable FK | 同上但 `charityId` 可為 null | 支援草稿態 / 平台官方活動 / 跨團體聯合無主辦 | 查詢都要 null check;cascade 需改 SetNull;application 層信任度低;**MVP 無這些 case** |
| 三 entity 完全獨立(無 FK)| Project / SaleItem 不與 Charity 關聯 | schema 最簡;migration 最快;test 最少 | **違反 domain 語意** — 募款必有受款人;接金流後 audit 鏈斷裂 |
| M:N(`CharityCollaboration` join 表)| 多 Charity 共同主辦 Project / SaleItem | 支援聯合活動 | Figma 無此 UI;產品已確認「都只對應一個公益團體」;**過度設計** |
| STI(`donation_items` 單表 + discriminator)| 三 entity 共用一張表 + `type` 欄位 | DRY:共用 query 邏輯與 index | nullable 欄位多;TS 型別鬆;未來型別分歧時要大改;Prisma 表達差 |

## 決策

採用 **1:N + `charityId` NOT NULL FK + `onDelete: Restrict`**:

```
Charity 1 ─── N DonationProject
        1 ─── N SaleItem

DonationProject.charityId  String  NOT NULL  → charities.id  onDelete: Restrict
SaleItem.charityId         String  NOT NULL  → charities.id  onDelete: Restrict
```

DonationProject 與 SaleItem 之間**無**關聯。

## 理由

### 1. Domain 語意要求 FK

募款 / 義賣的本質是「錢給誰、營收歸誰」:

- 一個募款專案沒有主辦團體 = 募到的錢沒有受款人,法律 / 會計上是異常狀態
- 一件義賣商品沒有銷售團體 = 營收沒有歸屬,同樣異常

DB schema 應該**禁止**異常狀態出現,而不是允許後在 application 層擋。NOT NULL 是把這個 invariant 寫在最底層。

### 2. NOT NULL 換來查詢與型別的簡單

```ts
// charityId NOT NULL — application 層可直接信任
const charityName = await getCharityName(project.charityId)

// charityId nullable — 到處要處理 null
const charityName = project.charityId
  ? await getCharityName(project.charityId)
  : '(無主辦團體)'
```

Prisma 產生的 TS 型別也跟著乾淨:`string` vs `string | null`。長期下游成本(每個 service / route / template 都要處理 null)遠大於 schema 寬鬆帶來的彈性。

### 3. `Restrict` 保護歷史資料

刪 Charity 的真實場景:後台誤點、權限被入侵、批次腳本失控。任一狀況下,連帶刪掉所有 Project / SaleItem 都是**不可逆**的災難 — 尤其本作業範圍外的 `Donation`(捐款交易)entity 日後接入後,Cascade 會吞掉捐款紀錄,違反稅務 / 法律保留義務。

`Restrict` 把刪除動作擋下、強迫操作者明確處理子表(刪除 / archive / 轉移),是防呆的最後一道。

`SetNull` 不可行,因為違反 §決策 的 NOT NULL 約定。

### 4. 1:N 對應現實,M:N 是過度設計

- 多數公益專案 / 義賣商品都是**單一團體主辦**
- 聯合活動(M:N)雖存在但是少數
- 產品 2026-06-14 明確確認:「捐款專案和義賣商品都只會對應一個公益團體」

把 schema 收緊到 1:N,日後真要 M:N 也只需新增 `CharityCollaboration` join 表,**Project / SaleItem 的 `charityId` 保留為「主辦團體」語意,join 表記錄協辦** — 1:N 是 M:N 的真子集,不會卡住未來。

### 5. 三 entity 獨立 schema(不走 STI)

STI 把三個 entity 塞進同一張表 + `type` discriminator,看似 DRY 但代價:

- 即使 spec 015 v0.4 三 entity 欄位 shape 一樣,**未來型別分歧**(Project 加 `targetAmount` / SaleItem 加 `price`)時,nullable 欄位會爆炸
- Prisma 對 STI 表達不順(沒原生 inheritance,需 raw SQL 或 view)
- API endpoint `/v1/donation-items?type=X` 比 `/v1/donation/donation-projects` 模糊
- TS 型別鬆:同一個 `DonationItem` 型別要 union 多種變體,handler 處處 narrow

三張獨立表 + Prisma client 各自出口,型別端到端最乾淨(呼應 ADR 002 / 007)。

## 不採用其他選項的權衡

### 不採用「三 entity 完全獨立」

這個選項在 spec 015 v0.3 短暫採用過。技術上最簡單,migration / test 也最少,但**只是因為 MVP 暫不接金流,看起來沒事**。實際代價:

- 日後加 `Donation` / `SaleOrder` entity 時,FK 從哪建?從 `Donation` 直接到 `Charity` 跳過 Project 嗎?
- audit 鏈斷裂:無法用一次 query 答「該團體所有歷史活動」
- application 層必須自己維護「Project 屬於 Charity」的隱性約束,違反「DB schema 應表達 domain 約束」原則

**Lesson learned**:DB schema 對 domain 語意應從嚴,不應為了技術簡化犧牲約束。schema 收緊比放鬆容易 — 收緊需要 backfill + 約束驗證,放鬆只要 `ALTER COLUMN DROP NOT NULL`。

### 不採用「nullable FK」

支援 nullable 的三個 case 都未在 MVP 範圍:

- **草稿態 Project**:本作業無後台 / 寫入端點,Project 都由 seed 灌入,不存在「先建 Project 後綁 Charity」
- **平台官方活動**:本作業無「平台」概念
- **跨團體聯合無主辦**:已確認 1:N,不存在

允許 nullable = 現在就為**未必發生的未來**付出所有查詢的 null check 成本,典型 YAGNI 反例。

### 不採用 M:N

產品已明確確認,且 Figma 無聯合活動 UI。若未來需要,**升級路徑無痛**:
- `charityId` 保留為「主辦團體」
- 新增 `CharityCollaboration { charityId, donationProjectId }` join 表
- API 加 `collaborators` 欄位

完全 additive,不破壞既有資料。

### 不採用 STI

詳見 §理由 5。簡言之:當前共用結構是巧合,不應假設未來保持共用;真共用的部分用程式碼層 generic 抽象(spec 016 §11)即可,不必上 schema。

## 實作要點

### Schema

- Prisma model:見 spec 015 §3
- 索引:`(charityId)` on Project / SaleItem,for FK lookup + `?charityId=` 過濾
- `onDelete: Restrict`,**禁止**用 Cascade / SetNull

### Migration 順序

1. 建 `charities`
2. 建 `donation_projects` + `sale_items`(FK → `charities`)
3. trigram GIN index(三表)

回滾順序相反:`sale_items` → `donation_projects` → `charities`。

### Seed

- 每個 Charity **至少 1 個** DonationProject + 1 個 SaleItem
- 至少 1 筆每張表名稱含「流浪動物」(對應 Figma demo query)
- idempotent:先刪子表再刪主表(避免 Restrict)

### API 對外

- Project / SaleItem list endpoint 接受 `?charityId=<uuid>` 過濾
- response item 包含 `charityId`,但**不**嵌完整 Charity 物件(避免 N+1 用 `?include=charity` 屬未來 additive)
- 詳細見 spec 016 §4.2 / §4.4

### 測試必跑

- **FK NOT NULL**:`prisma.donationProject.create` 不帶 `charityId` 必須 throw
- **FK existence**:`prisma.donationProject.create` 帶不存在的 `charityId` 必須 throw FK constraint
- **Restrict cascade**:有 Project 時刪 Charity 必須 throw,清乾淨 children 後才能成功
- 見 spec 015 §11

## 升級觸發

以下情境出現時,需重新評估本決策(對應 spec 015 §12 開放問題):

| 觸發 | 評估方向 |
|---|---|
| 「Charity 還沒建好,Project 先存草稿」需求 | 改 `charityId` nullable + cascade 改 SetNull;backfill 既有資料保留 NOT NULL 行為 |
| 「平台官方發起、不掛 Charity 的活動」需求 | 同上,或建一個 system charity(更乾淨) |
| 「跨團體聯合活動」需求 | 新增 `CharityCollaboration` join 表,`charityId` 維持為主辦團體 |
| 「義賣商品歸屬某募款專案」需求 | `SaleItem.donationProjectId` nullable FK,屬 additive |
| 接金流(`Donation` / `SaleOrder` entity)| 本決策的 `Restrict` 重要性上升,因捐款 / 訂單紀錄 = 法律保留資料;此時可考慮對 Charity 改 soft delete + Restrict 雙保險 |

## 下游影響

本決策定錨後,以下文件已對齊:

- **Spec 015 v0.4**(資料模型) — 三 model 含 FK / Restrict / 索引 / seed
- **Spec 016 v0.4**(列表 / 搜尋 API) — Project / SaleItem endpoint 含 `?charityId=` 過濾與 response `charityId` 欄位
- **Frontend brief v0.3** — 三 tab 皆實作

後續若引入 `Donation` / `SaleOrder` / `Favorite`,需在各自 ADR 引用本決策,避免重新討論。

## 變更紀錄

| 日期 | 變更 |
|---|---|
| 2026-06-14 | 初版。定錨 1:N + NOT NULL FK + Restrict,終止反覆討論 |
