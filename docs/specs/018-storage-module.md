# Spec 018:S3 物件儲存模組(images / assets)

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.5 |
| 日期 | 2026-06-14 |
| 適用範圍 | `backend/src/lib/s3/*`、`backend/src/routes/v1/donation/uploads/*`、`backend/src/schemas/uploads/*` |
| 相關 ADR | `../../docs/decisions/008-ecs-cicd-pilot.md`(專案級 — ECS Fargate IAM role 是 S3 認證來源)|
| 相關 spec | `001-environment-config.md`(env vars 新增)、`002-env-example-template.md`(範本)、`011-health-check.md`(`/health/storage` 端點)、`013-test-infrastructure.md`(LocalStack 容器整合)、`015-charity-data-model.md`(`logoUrl` / `coverImageUrl` 欄位的來源)、`016-charity-list-api.md`(response 中的 URL 來自本模組 `objectUrl()`)|
| 設計來源 | 2026-06-14 產品確認:「各資源的圖片想放到 AWS 的 S3」;Figma 設計中所有 logo / cover 都是圖片 |

---

## 1. 目的與範圍

> **URL prefix(spec 023 §2 已落地)**:本 spec 列的 endpoint path **不含 surface prefix**。實際 client URL 依 surface 加前綴:
> - Public read endpoints → `/user/v{N}/...`(spec 023 §2.2;當前 `v1`)
> - Admin write endpoints → `/cms/...`(spec 023 §2.3,scope-level `requireAdmin` 由 `/cms` plugin attach)
> - Auth endpoints → `/auth/...`(spec 023 §2.1,不版本化)
>
> Endpoint URL 完整 mapping 表見 spec 023 §2.4。

### 1.1 目的

把 spec 015 中各 entity 的圖片欄位(`Charity.logoUrl`、`DonationProject.coverImageUrl` 等)真正落到 AWS S3,並提供:

- **後端到 S3 的 client 抽象**(`src/lib/s3/`)
- **前端直接上傳的安全管道**(pre-signed PUT URL,backend 不經手檔案 bytes)
- **公開讀取的 URL 規約**(public bucket + 固定 URL pattern,frontend 直接 `<img src>` 載入)
- **本地開發 / 測試環境**(LocalStack via docker-compose,呼應 spec 013「不 mock infra,跑真容器」)

### 1.2 In scope

- `S3Client` singleton 與生命週期
- env 配置與 IAM 認證方式(ECS task role vs access key)
- Key 命名規約(`donation/{entity}/{id}/{purpose}.{ext}`)
- 公開 bucket 政策與 URL builder
- `GET /v1/donation/uploads/presign` 端點(pre-signed PUT)
- LocalStack 整合(dev + integration test)
- 健康檢查(`/health/storage`,獨立非 readiness 必要)

### 1.3 Out of scope

- **CloudFront / CDN**:本 v0.1 用直接公開 bucket(`https://<bucket>.s3.<region>.amazonaws.com/<key>`),未來引入 CDN 屬 additive(僅改 `objectUrl()` 與 bucket policy)
- **圖片處理 / 縮圖**(thumbnail / resize):若需,走 Lambda + S3 trigger 或 frontend 在上傳前處理;本 spec 不涵蓋
- **檔案類型驗證之外的內容檢查**(病毒掃描、NSFW 偵測):未來再加
- **下載統計 / access log**:S3 內建 access log 自行啟用,不在 application 層追
- **私有檔案 / 簽章下載 URL**:本作業圖片皆公開,不需 GET presign

---

## 2. 設計原則

1. **Pre-signed PUT 為主上傳路徑**:Backend 不經手檔案 bytes,僅產生 signed URL,frontend 直接 PUT 到 S3。網路成本、安全邊界都最乾淨(產品確認)
2. **公開讀,直接 S3 URL**:bucket policy `AllowPublicRead`(產品確認);未來改 CDN 屬 additive,只改 URL builder
3. **IAM role 認證,**禁**用 access key in env**:呼應 ADR 008,backend 在 ECS Fargate 上以 task role 取 S3 權限;local dev 用 LocalStack 不需真認證
4. **Key 命名是 contract**:`donation/{entity}/{id}/{purpose}.{ext}`,讓 ops 看 S3 就能對應 DB row,debug 與遷移皆方便
5. **LocalStack 對齊 spec 013**:不 mock S3 SDK 介面,啟動真容器跑,行為與 prod 一致
6. **S3 不在 readiness probe**:S3 短暫故障時,backend 不該被 LB 移除(列表 / 詳情仍可服務,圖片 URL 載入失敗由 frontend 處理),呼應 spec 011 §2.1 「Liveness 不查依賴、Readiness 用 shallow 檢查」

---

## 3. 模組結構

```
backend/src/lib/s3/
├── client.ts              # S3Client singleton + lifecycle(`closeS3Client()` 由 spec 011 graceful shutdown hook 呼叫 `client.destroy()` 釋放 HTTP handler;v0.4)
├── config.ts              # env 解析(spec 001 對齊)
├── key.ts                 # buildKey({ entity, id, purpose, ext })
├── url.ts                 # objectUrl(key) → 公開 https URL
├── presigned.ts           # getPresignedUploadUrl({ key, contentType, contentLength, ttl })
├── policy.ts              # 上傳驗證(contentType 白名單、size 上限)
├── health.ts              # checkConnectivity() — HEAD bucket(對齊 spec 011 §7.2 1s coalesce cache)
└── errors.ts              # S3 SDK error → application error mapping
```

### 3.1 套件清單(v0.3 新增)

| 套件 | 用途 | 來源 |
|---|---|---|
| `@aws-sdk/client-s3` | `S3Client` / `HeadBucketCommand` / `PutObjectCommand` | npm |
| `@aws-sdk/s3-request-presigner` | `getSignedUrl()`(預簽 PUT URL)| npm |

兩者皆 **runtime dep**(`dependencies`,非 dev)。AWS SDK v3 是 modular,只裝 S3 子套件,不裝整套 v2 monolith。

對應 routes / schemas(spec 016 系列):

```
backend/src/routes/v1/donation/uploads/
└── presign.ts             # GET /v1/donation/uploads/presign

backend/src/schemas/uploads/
└── presign.ts             # TypeBox: PresignQuery / PresignResponse
```

---

## 4. Config(env vars)

新增於 spec 001(`001-environment-config.md`)的 env 字典:

| 變數 | 預設 / 範例 | 範圍 | 說明 |
|---|---|---|---|
| `S3_BUCKET` | `jko-donation-prod-assets` | 必填 | bucket 名,跨環境(dev / stage / prod)各自獨立 |
| `S3_REGION` | `ap-northeast-1` | 必填 | 與 ADR 008 ECS 所在 region 對齊 |
| `S3_ENDPOINT` | (空 → SDK 預設 AWS;LocalStack 為 `http://localhost:4566`)| 選填 | 僅 LocalStack / 自架 S3 相容(如 MinIO)用 |
| `S3_FORCE_PATH_STYLE` | `false`(LocalStack 必須 `true`)| 選填 | path-style URL vs virtual-hosted style;**boolean parse 走 strict** — 僅 `'true'` 視為 true,其他(`'1'` / `'yes'` / `'TRUE'`)皆 false(v0.3 — 與 spec 001 既有 env parsing 慣例對齊)|
| `S3_PUBLIC_URL_BASE` | (空 → 用 `https://<bucket>.s3.<region>.amazonaws.com`)| 選填 | 未來改 CloudFront 時填 `https://cdn.jko-donation.com` |
| `S3_PRESIGN_TTL_SECONDS` | `300`(5 分鐘) | 選填 | pre-signed PUT URL 壽命 |
| `S3_MAX_UPLOAD_BYTES` | `5_242_880`(5 MB)| 選填 | 上傳檔大小上限,寫入 pre-signed policy |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | (prod **禁**設,local dev / CI 可設)| 選填 | prod 走 IAM task role,**不**從 env 取 |

### 4.1 認證來源優先序

```
1. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY(env)— 僅 dev / CI / LocalStack 路徑
2. IAM task role(ECS Fargate metadata service)— prod 唯一路徑
3. EC2 instance profile — 本專案 ECS-only,不會走到
4. 開發者本機 ~/.aws/credentials — 接近 dev 路徑,允許但不推薦
```

啟動時 SDK 自動 chain,client 不必手動分支。

### 4.1.1 ECS task role 必要的 IAM policy(v0.3 新增)

Prod 部署在 ECS Fargate(ADR 008),task role 需附下列 inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DonationAssetsRW",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:HeadObject",
        "s3:HeadBucket"
      ],
      "Resource": [
        "arn:aws:s3:::jko-donation-prod-assets/*",
        "arn:aws:s3:::jko-donation-prod-assets"
      ]
    }
  ]
}
```

> `s3:HeadBucket` 給 `/health/storage`(§10)用;`s3:HeadObject` 給未來「驗證上傳完成」流程預留;`s3:DeleteObject` **不**開放(本作業無刪除流程,符合 least privilege)。

### 4.2 啟動 fail-fast 驗證(v0.3 新增)

`S3_BUCKET` / `S3_REGION` 為 **必填**,缺值時 plugin 註冊期立即 throw 並停 process(對齊 spec 006 Redis 模組做法):

```ts
// src/lib/s3/config.ts
export function loadS3Config(env: NodeJS.ProcessEnv): S3Config {
  const bucket = env.S3_BUCKET
  const region = env.S3_REGION
  if (!bucket || !region) {
    throw new ConfigError(
      'S3_BUCKET / S3_REGION 為必填;dev 可寫 LocalStack 值(例 local-dev-assets / ap-northeast-1)'
    )
  }
  // bucket 名 dot 限制(v0.3 — virtual-hosted style URL 不支援含 dot 的 bucket)
  if (!env.S3_FORCE_PATH_STYLE && bucket.includes('.')) {
    throw new ConfigError(
      `S3_BUCKET="${bucket}" 含 dot,virtual-hosted style URL(預設)不支援;改 path-style(S3_FORCE_PATH_STYLE=true)或改 bucket 名`
    )
  }
  return { bucket, region, ... }
}
```

**理由**:S3 連線錯誤在 runtime 第一次呼叫才爆,debug 成本高;startup 抓住缺 env 的問題,讓 deploy 立刻失敗、不會帶錯設定上線。

---

## 5. Key 命名規約

### 5.1 Pattern

```
donation/{entity}/{id}/{purpose}.{ext}
```

| segment | 規則 | 範例 |
|---|---|---|
| `donation/` | feature namespace(對齊 API URL prefix,spec 016 v0.7)| `donation/` |
| `{entity}` | kebab-plural,對齊 spec 016 endpoint 名稱 | `charities` / `donation-projects` / `sale-items` |
| `{id}` | entity 的 uuid(spec 015 PK)| `0e1b...c9` |
| `{purpose}` | 用途 label(白名單) | `logo` / `cover` |
| `{ext}` | 副檔名,小寫,**僅** `png` / `jpg` / `jpeg` / `webp` / `gif`(白名單)| `png` |

### 5.1.1 contentType → ext 映射(v0.4)

§7.1 client 帶 `contentType`,backend 自己推 ext 寫進 key。固定映射如下:

| contentType | 新簽章用的 `ext` |
|---|---|
| `image/png` | `png` |
| `image/jpeg` | **`jpg`**(`.jpeg` 仍在白名單,僅向前相容讀取舊上傳;**新 key 一律 `jpg`**)|
| `image/webp` | `webp` |
| `image/gif` | `gif` |

**為何固定 jpg(不讓 client 選)**:`image/jpeg` 與 `.jpg`/`.jpeg` 是同一個格式,兩種副檔名並存會出現「同一張圖兩個 key」這種人為錯位。固定 `jpg` 較通用、URL 短,符合 §5.3「lowercase ext 避免 dup」精神。實作於 `policy.ts`:

```ts
const CONTENT_TYPE_TO_EXT = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif':  'gif',
} as const
export type AllowedContentType = keyof typeof CONTENT_TYPE_TO_EXT
```

### 5.2 範例

```
donation/charities/0e1b41a8-.../logo.png
donation/donation-projects/7f23.../cover.jpg
donation/sale-items/4d5e.../cover.webp
```

### 5.3 為何這樣命名

- **`donation/` prefix**:同一 bucket 未來可放其他 feature 的 asset(`bff/`、`audit/`),不互相污染
- **{entity}/{id}**:S3 console 直接看就能對應 DB row;ops debug 不必查表
- **{purpose}**:同一 entity 多種圖(logo + cover),用 path 不用 query;CDN cache 友善
- **lowercase ext**:大小寫差異會被視為不同 key,規定 lowercase 避免 dup
- **不嵌時間戳**:`updatedAt` 在 DB,需要 cache busting 時用 query string(`?v=<updatedAt>`),不污染 key

### 5.4 為何不用「flat UUID + 副檔名」

```
donation/{uuid}.png                  ← 替代方案
```

- 優點:更短、更隨機(不洩漏 entity 結構)
- 缺點:S3 看不出對應到誰、`{purpose}` 也無法表達;debug 時要查 DB

對 MVP 公開圖片場景,**可 debug 性 > 隱蔽性**,選結構化 path。

---

## 6. Bucket 政策(public read)

### 6.1 Bucket policy 範本

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowPublicRead",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::jko-donation-prod-assets/*"
    }
  ]
}
```

- `s3:GetObject` 公開 — 對應「捐款公益活動圖片希望被分享」的語意
- `s3:PutObject` / `DeleteObject` **不**公開 — 寫入只能透過 pre-signed URL(來自 backend 的 signed PUT)

### 6.2 Block Public Access 設定

| 設定 | 值 |
|---|---|
| Block public access via ACL | **on** — ACL 完全不開放(防止 misconfigured upload 設成 public)|
| Block public access via bucket policy | **off** — 為了 §6.1 的 policy 生效 |
| Block public access via cross-account ACL | **on** |
| Block all public access | 自動 → 否 |

> Anti-pattern:**不**用 `AllowPublicAccess via ACL` + 設物件 `public-read` ACL — 太容易誤設;bucket policy 為單一信任源。

### 6.3 CORS 配置(v0.2 新增)

Pre-signed PUT 是 **cross-origin** 請求(frontend `https://app...` PUT 到 S3 `https://...amazonaws.com`),S3 必須回 CORS preflight 才能成功。**沒這個配置 = browser 上傳整個炸**(只剩 server-side 上傳能跑,違反 §設計原則 1)。

Bucket CORS rules:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": [
        "https://app.jko-donation.com",
        "https://staging.jko-donation.com",
        "http://localhost:3000"
      ],
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

| 欄位 | 設計 |
|---|---|
| `AllowedOrigins` | **白名單**,**禁** `*`;dev / staging / prod 各自加入 |
| `AllowedMethods` | `PUT`(上傳)+ `GET` / `HEAD`(載入時 browser 偶爾發 preflight)|
| `AllowedHeaders` | **`["*"]`** — v0.3 修正(S3 CORS **不**支援 `x-amz-*` 之類 prefix wildcard,只支援單一 `*` 或精確 header 列表;SDK presigned PUT 會帶不確定數量的 `x-amz-*` 簽章 header,寫死任何 exact 列表都會漏)|
| `ExposeHeaders` | `ETag`(frontend 可拿 ETag 確認上傳完整性) |
| `MaxAgeSeconds` | preflight 結果 cache 1 小時,降低 OPTIONS 次數 |

> 這份 CORS 設定**獨立於** `Block Public Access`,兩者並行(BPA 控資產讀取、CORS 控瀏覽器跨域)。
> 設定方式:`aws s3api put-bucket-cors --bucket <bucket> --cors-configuration file://cors.json`;在 IaC 用 CloudFormation / Terraform 管理。
> LocalStack 也支援同一份 CORS rules(local dev 必須設,否則 browser 對 `localhost:4566` 也擋)。

### 6.4 為何不用 CloudFront(v0.1)

| 角度 | Public bucket(採用)| CloudFront |
|---|---|---|
| 設定 | 一個 bucket policy | bucket policy + distribution + OAC + alternate domain + cert |
| 延遲(亞洲)| 直接 S3 region(ap-northeast-1)約 20-50ms | CDN edge < 30ms |
| Cost | S3 GET 流量費 | CloudFront 流量費(略低 + edge cache hit 省 origin) |
| TLS | `*.amazonaws.com` SAN 證書 | 自訂網域 cert |
| Access log | S3 access log(分析較陽春) | CloudFront access log(豐富) |
| Cache invalidation | bust query string | `CreateInvalidation` API |

**結論**:MVP 用 public bucket 已足;升級 CDN 屬 additive,只改 `S3_PUBLIC_URL_BASE` env 與 bucket policy(改成只允許 CloudFront OAC),不動 application 層。列為 §13 開放問題。

---

## 7. `GET /v1/donation/uploads/presign`

### 7.1 Request

```http
GET /v1/donation/uploads/presign?entity=<entity>&id=<id>&purpose=<purpose>&contentType=<mime>&fileSize=<bytes> HTTP/1.1
```

| 參數 | 必填 | 規則 |
|---|---|---|
| `entity` | ✅ | `charities` / `donation-projects` / `sale-items`(白名單) |
| `id` | ✅ | uuid v4(對應目標 entity 的 PK) |
| `purpose` | ✅ | `logo` / `cover`(白名單) |
| `contentType` | ✅ | `image/png` / `image/jpeg` / `image/webp` / `image/gif`(白名單,對應 §5.1 ext) |
| `fileSize` | ✅ | int,bytes;上限 `S3_MAX_UPLOAD_BYTES`(預設 5 MB) |

### 7.1.1 ContentLength 必須進簽章(v0.3 — 安全關鍵)

`PutObjectCommand` 必須帶 `ContentLength: fileSize`,讓 SigV4 簽章把 `content-length` 納入 `SignedHeaders`:

```ts
// src/lib/s3/presigned.ts
const command = new PutObjectCommand({
  Bucket: config.bucket,
  Key: key,
  ContentType: contentType,
  ContentLength: fileSize,        // ← v0.3:不帶這行,S3 不會卡上傳大小
})
const url = await getSignedUrl(client, command, { expiresIn: ttl })
```

**為什麼必要**:不帶 `ContentLength`,簽章只覆蓋 URL + `content-type`,client 可上傳任意大小檔案;`fileSize` query 變成 server 端 soft check,**S3 端強制失效**。攻擊面:用 5MB 的 quota 上傳 1GB → 帳單爆炸。

帶上後:client 改傳不同大小 → `Content-Length` header 不符簽章 → S3 直接 reject 403,**從 protocol 層卡死**。

### 7.2 Response(200)

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Request-Id: <uuid>
Cache-Control: no-store              # v0.2 — 每次簽章皆異,禁中介層 cache(覆寫 spec 009 §8.1 預設)
```

```jsonc
{
  "url": "https://jko-donation-prod-assets.s3.ap-northeast-1.amazonaws.com/donation/charities/0e1b.../logo.png?X-Amz-Algorithm=...&X-Amz-Credential=...&X-Amz-Date=...&X-Amz-Expires=300&X-Amz-Signature=...",
  "method": "PUT",
  "headers": {
    "Content-Type": "image/png"
  },
  "key": "donation/charities/0e1b.../logo.png",
  "publicUrl": "https://jko-donation-prod-assets.s3.ap-northeast-1.amazonaws.com/donation/charities/0e1b.../logo.png",
  "expiresAt": "2026-06-14T01:28:45.678Z"
}
```

| 欄位 | 說明 |
|---|---|
| `url` | pre-signed PUT URL,frontend 用 `fetch(url, { method: 'PUT', body: file, headers })` 上傳 |
| `method` | 固定 `PUT`(Client SDK 也可用 POST + form,本 v0.1 統一 PUT)|
| `headers` | 上傳時必須帶的 headers(`Content-Type` 等於簽章時的值,否則 S3 拒收) |
| `key` | S3 object key(對應 §5)|
| `publicUrl` | 上傳成功後可立即用 `<img src>` 載入的 URL(等價 `objectUrl(key)`)|
| `expiresAt` | URL 失效時間,ISO 8601 |

### 7.3 Auth

本作業 **無登入機制**(brief out of scope),v0.1 留 placeholder:**端點開放 public**。

實際 production 應加 auth(只有後台 admin 能拿 signed URL),Auth middleware 整合於 spec 007 / 008 完成後接上。本 spec §13 列為開放問題。

### 7.4 錯誤

沿用 spec 005 RFC 7807:

| Status | code | 觸發 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | 參數不在白名單 / 格式錯 / `fileSize` 超出 |
| 404 | `<ENTITY>_NOT_FOUND` | `id` 對應的 entity 不存在(避免幫不存在的 row 簽 URL) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `contentType` 不在白名單 |
| 429 | `RATE_LIMITED` | **獨立嚴格 bucket**:`10 req / min / IP`(v0.2 修正:每次簽章 = 核發 1 次寫 S3 capacity,abuse 風險與 read endpoint 完全不同;絕**不**共用 read bucket)。bucket 名 `presign-upload`,落 spec 010 設定檔 |
| 500 | `INTERNAL` | S3 SDK 錯誤 |

### 7.4.1 entity → 404 code mapping + `checkEntityExists()` 實作 hint(v0.4)

URL 中的 entity(kebab-plural)→ 對應 Prisma delegate + 404 code:

| URL entity | Prisma delegate | 404 code(§7.4)|
|---|---|---|
| `charities` | `prisma.charity` | `CHARITY_NOT_FOUND` |
| `donation-projects` | `prisma.donationProject` | `DONATION_PROJECT_NOT_FOUND` |
| `sale-items` | `prisma.saleItem` | `SALE_ITEM_NOT_FOUND` |

**Service 層實作建議**(放 `src/domain/uploads/check-entity.ts`):

```ts
import { prisma } from '@/db/client'

const ENTITY_TABLE = {
  'charities':         { delegate: prisma.charity,         code: 'CHARITY_NOT_FOUND' },
  'donation-projects': { delegate: prisma.donationProject, code: 'DONATION_PROJECT_NOT_FOUND' },
  'sale-items':        { delegate: prisma.saleItem,        code: 'SALE_ITEM_NOT_FOUND' },
} as const

export type UploadEntity = keyof typeof ENTITY_TABLE

export async function ensureEntityExists(entity: UploadEntity, id: string): Promise<void> {
  const { delegate, code } = ENTITY_TABLE[entity]
  const row = await delegate.findUnique({ where: { id }, select: { id: true } })
  if (!row) throw new NotFoundError(code)
}
```

Route handler 只需呼叫 `await ensureEntityExists(entity, id)`,error 由 spec 005 errorHandler 自動轉 RFC 7807。

### 7.5 流程圖

```
[前置]
    Step 0(v0.3 補註):entity row 必須**已存在於 DB**(`id` 對應到實際 charity / project / sale_item)。
                       本端點 §7.4 在 entity 不存在時回 404,**不**簽 URL — 避免簽出懸空 key。

[Two-step create 模式]
    - 真實場景:admin UI 流程應為「先 POST create(無圖)拿 id → presign → 上傳 → PATCH 寫 logoKey」
    - 本作業階段:寫入 endpoint 不存在(brief out of scope),seed 寫死 publicUrl,本端點目前無實際呼叫場景

[Frontend (admin UI)]
    │
    │ 1. GET /v1/donation/uploads/presign?entity=charities&id=...&purpose=logo&contentType=image/png&fileSize=120000
    ▼
[Backend]
    │  - 驗白名單、查 entity 存在、檢查 size 上限
    │  - 呼 S3 SDK getSignedUrl(PutObjectCommand, ttl)
    │
    │ 2. 200 OK { url, headers, key, publicUrl, expiresAt }
    ▼
[Frontend]
    │
    │ 3. PUT <url>  Body: <file>  Headers: Content-Type: image/png
    ▼
[S3]
    │
    │ 4. 200 OK(client 直接收 S3 回應)
    ▼
[Frontend]
    │
    │ 5. POST /v1/donation/charities/:id   Body: { logoUrl: <publicUrl> }
    │    ↑ 寫入 DB 的端點(本作業 brief out of scope,寫入流程留待後續 admin UI spec)
    │    本作業階段:seed 寫死 publicUrl,不走此流程
```

> Step 5(寫入 DB)在本作業 **out of scope**(brief 無後台 UI / 寫入端點)。本 v0.1 只有 presign 端點,真正用上的場景待後續 admin UI 補。Seed 階段 `logoUrl` / `coverImageUrl` 仍**寫死**為 `publicUrl` 格式字串。

---

## 8. URL builder

### 8.1 `objectUrl(key)`

```ts
// src/lib/s3/url.ts
export function objectUrl(key: string): string {
  const base = config.publicUrlBase
    ?? `https://${config.bucket}.s3.${config.region}.amazonaws.com`
  return `${base}/${key}`
}
```

### 8.2 Cache busting

當 entity 更新圖(同 key 覆寫),browser cache 會回舊圖。對策:

```ts
// 用 updatedAt timestamp 當 query string
const url = `${objectUrl(key)}?v=${entity.updatedAt.getTime()}`
```

URL builder 預設**不**加 `v` query;由呼叫端(spec 016 / 017 response 組裝)視情況加。本 spec v0.1 不強制,列為開放問題(§13)。

---

## 9. LocalStack 本地開發

### 9.1 docker-compose

對齊 `backend/docker-compose.yml`(spec 013 已啟動 PostgreSQL / Redis 的同檔):

```yaml
services:
  # ... 既有 postgres / redis ...

  localstack:
    image: localstack/localstack:3
    ports:
      - "4566:4566"
    environment:
      SERVICES: s3
      DEBUG: 0
      DATA_DIR: /tmp/localstack/data
      PERSISTENCE: 1                   # 重啟保留 bucket / objects
    volumes:
      - localstack_data:/var/lib/localstack
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4566/_localstack/health"]
      interval: 5s
      timeout: 2s
      retries: 10

volumes:
  localstack_data:
```

### 9.2 Local env

`.env.local`(對齊 spec 002 `.env.example`):

```env
S3_BUCKET=local-dev-assets
S3_REGION=ap-northeast-1
S3_ENDPOINT=http://localhost:4566
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_URL_BASE=http://localhost:4566/local-dev-assets
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
S3_PRESIGN_TTL_SECONDS=300
S3_MAX_UPLOAD_BYTES=5242880
```

LocalStack 不檢查 credentials 內容,任意非空字串即可。

### 9.3 Bootstrap script

`backend/scripts/bootstrap-localstack.sh`(`docker-compose up` 後手動跑一次,或 seed 流程的前置):

```bash
#!/usr/bin/env bash
set -euo pipefail

LS=http://localhost:4566
BUCKET=local-dev-assets

# 1. 建 bucket(idempotent)
aws --endpoint-url=$LS s3 mb s3://$BUCKET 2>/dev/null || true

# 2. 公開讀 policy(對齊 spec 018 §6.1)
aws --endpoint-url=$LS s3api put-bucket-policy --bucket $BUCKET \
  --policy "$(jq -n --arg bucket "$BUCKET" '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::\($bucket)/*"}]
  }')"

# 3. CORS(v0.3 — 對齊 §6.3;沒這段 browser 跨域 PUT 在 dev 整個炸)
aws --endpoint-url=$LS s3api put-bucket-cors --bucket $BUCKET \
  --cors-configuration "$(jq -n '{
    "CORSRules":[{
      "AllowedOrigins":["http://localhost:3000"],
      "AllowedMethods":["PUT","GET","HEAD"],
      "AllowedHeaders":["*"],
      "ExposeHeaders":["ETag"],
      "MaxAgeSeconds":3600
    }]
  }')"
```

> 三步驟皆 idempotent:`mb` 用 `|| true` 吞重複建立的 error;`put-bucket-policy` / `put-bucket-cors` 重複跑會覆蓋(冪等)。

### 9.4 Integration test

呼應 spec 013(testcontainers):

```ts
// tests/setup/localstack.ts
import { GenericContainer } from 'testcontainers'

export async function startLocalStackS3() {
  const container = await new GenericContainer('localstack/localstack:3')
    .withExposedPorts(4566)
    .withEnvironment({ SERVICES: 's3' })
    .withWaitStrategy(/* health check */ ...)
    .start()
  // ... bootstrap bucket、回傳 endpoint + cleanup hook
}
```

每個 integration test 檔 `beforeAll` 起獨立容器,`afterAll` 停 — 與 spec 013 既有 Postgres / Redis 模式一致。

---

## 10. Health check 整合

### 10.1 `GET /health/storage`

新增端點(對齊 spec 011 §3 設計):

| Path | 用途 | 期望 |
|---|---|---|
| `GET /health/storage` | S3 連線單獨診斷 | < 200ms |

### 10.2 檢查邏輯

```
1. S3Client.send(new HeadBucketCommand({ Bucket }))
2. timeout 1s
3. 成功 → 200 + { status: 'ok', bucket: '<name>' }
4. 失敗 → 503 + { status: 'unhealthy', reason: 'S3 unreachable' }
```

### 10.2.1 1s coalesce cache(v0.3 — 對齊 spec 011 §7.2)

呼應 spec 011 既有 in-memory probe cache:**`/health/storage` 套同樣的 1s coalesce**,避免高頻 probe 對 S3 帳單與延遲不必要消耗。

```ts
// src/lib/s3/health.ts
const cache = createProbeCache({ ttlMs: 1000 })   // spec 011 既有 helper
export const checkStorage = () =>
  cache.coalesce('s3', () => headBucket({ timeoutMs: 1000 }))
```

多個並發 probe 共用同一次 HEAD bucket 結果。

### 10.3 `/health/ready` 不查 S3

呼應 spec 011 §2.1:

> Readiness 用 shallow 檢查,DB / Redis 用 `SELECT 1` / `PING`,不查業務功能

S3 短暫故障時,**列表 / 詳情 endpoint 仍可服務**(URL 是字串,實際載入是 client 行為);把 S3 加進 readiness 會引發 LB 不必要的 cordoning。

**例外**:若日後加入「上傳即時功能」(presign 是核心使用者旅程),可重評是否進 readiness。本 spec v0.1 否。

---

## 11. 錯誤處理

### 11.1 SDK error → application error

```ts
// src/lib/s3/errors.ts
export function mapS3Error(e: unknown): AppError {
  if (e instanceof S3ServiceException) {
    switch (e.name) {
      case 'NoSuchBucket':       return new ConfigError('S3_BUCKET_MISCONFIGURED')
      case 'AccessDenied':       return new ConfigError('S3_ACCESS_DENIED')
      case 'TimeoutError':       return new TransientError('S3_TIMEOUT')
      case 'NetworkingError':    return new TransientError('S3_UNREACHABLE')
      default:                   return new InternalError('S3_UNKNOWN', e.message)
    }
  }
  return new InternalError('S3_UNKNOWN')
}
```

### 11.2 Retry 策略

- `getPresignedUploadUrl()`:**不 retry**(v0.3 釐清:純本地 SigV4 簽章運算,**完全不打 S3**,SDK 內建 retry 在這條 path 不會觸發;失敗一律代表 config / SDK bug → throw)
- `headBucket()`(健康檢查):**不 retry**(timeout 後直接視為不健康)
- 未來上傳 / 下載操作:由 AWS SDK 內建 retry(預設 3 次,exponential backoff),不在 application 層再 retry

---

## 12. 測試矩陣

| 層 | 案例 | 期望 |
|---|---|---|
| unit | `buildKey()`:正確組合;非法 entity / purpose / ext 必須 throw `VALIDATION_ERROR` | 對 |
| unit | `objectUrl(key)`:有 / 無 `S3_PUBLIC_URL_BASE` 兩種組合 | 對 |
| unit | `policy.ts` contentType 白名單;size 上限拒絕 | 對 |
| integration | LocalStack 跑 `getPresignedUploadUrl()` → 拿到 URL → PUT 上傳 → S3 內有檔 | 對 |
| integration | 上傳 contentType 與簽章不符 → S3 reject(verify error 路徑) | 對 |
| integration | URL 過期(TTL 後)→ PUT 回 403 | 對 |
| integration | `GET /v1/donation/uploads/presign` 帶不存在的 `id` → 404 `<ENTITY>_NOT_FOUND` | 對 |
| integration | `GET /health/storage` LocalStack 跑時 200;`docker stop localstack` 後 503 | 對 |
| e2e | 完整流程(presign → PUT → readback via `objectUrl()` GET → 圖片可見);**用純 Node `fetch()` 模擬 client**,**不**經 browser engine(v0.3 釐清)| 對 |
| e2e (CORS) | **不在本 spec 範圍** — Node `fetch()` 不執行 CORS preflight,要驗 CORS 需起 Playwright;v0.3 列為 §13 開放問題(本作業階段可省) | — |

---

## 13. 開放問題

- **Auth on `/v1/donation/uploads/presign`**:v0.1 為 public(brief 無登入機制);實作 admin UI 時要鎖管理員 role(spec 007 / 008 完成後接上)
- **CDN(CloudFront)**:目前直接公開 S3 bucket;升級走 additive(僅改 `S3_PUBLIC_URL_BASE` + bucket policy 限制 OAC),不動 application
- **Cache busting**:`objectUrl()` 預設不加 `?v=`;呼叫端視需要附加(v0.2 後 DB 存 key,response 組裝時用 `${objectUrl(key)}?v=${updatedAt.getTime()}`)。**是否在 spec 016 / 017 response 統一加** 待決
- **Old object 清理**:同 `key` 覆寫時舊圖直接被取代(同名);若 key 含時間戳變動,需 lifecycle policy 清舊版 — 本 spec v0.1 不處理(key 不含時間戳)
- **Multi-part upload**:>5MB 檔案需 multipart;本 spec v0.1 上限 5MB(`S3_MAX_UPLOAD_BYTES`)避開
- **圖片驗證 / sanitize**:目前只檢 contentType + size;未來如需病毒掃描 / NSFW 偵測,走 S3 trigger → Lambda,application 層不阻斷上傳
- **Server-side encryption**:S3 預設啟用 SSE-S3;若需 SSE-KMS,bucket policy + key policy 需另設,本 v0.1 用預設
- **Cross-region replication**:單 region(`ap-northeast-1`)足夠;災備需求出現時再評估
- **Cost monitoring**:S3 storage / request 費用未設預警;ops 範圍另立
- **CORS 行為的 e2e 測試**:Node `fetch()` 不執行 CORS preflight,真要驗 browser CORS 行為需 Playwright / puppeteer。本作業階段省略,留待 admin UI spec 完成後決定

---

## 14. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 2026-06-14 | 初版:pre-signed PUT 流程、公開 bucket 政策、`donation/{entity}/{id}/{purpose}.{ext}` key 規約、LocalStack dev/test、`/health/storage` 端點、9 個開放問題 |
| 0.2 | 2026-06-14 | conflict audit 修正:(1) §6.3 新增 **bucket CORS** 配置 — 沒這個 browser 跨域上傳會炸;(2) §7.2 修正 `Cache-Control: no-store`(每次簽章不同,原 `private, max-age=0` 語意不對);(3) §7.4 **rate limit 改獨立嚴格 bucket** `10 req/min/IP`,**禁**與 read endpoint 共用(每次簽章 = 核發 1 次 S3 寫 capacity);(4) cache busting open question 對齊「DB 存 key」(spec 015 v0.8 / spec 016 v0.10 同步)|
| 0.3 | 2026-06-14 | 實作前 audit 修正(2 CRITICAL + 3 HIGH + 5 MEDIUM/LOW):**CRITICAL** (1) §6.3 CORS `AllowedHeaders` `["x-amz-*"]` → `["*"]`(S3 不支援 prefix wildcard);(2) §9.3 bootstrap script 補 CORS 設定(沒這段 dev 跨域 PUT 整個跑不起來)。**HIGH** (3) §4.2 新增 fail-fast 啟動驗證;(4) §7.1.1 新增 `ContentLength` 必須進簽章(否則 S3 端不卡上傳大小,有 abuse 風險);(5) §7.5 Step 0 補「entity 必須先存在 DB」two-step create 註腳。**MEDIUM/LOW** (6) §3.1 新增套件清單;(7) §4 boolean parse strict `'true'`;(8) §4.1.1 新增 ECS task role IAM policy JSON;(9) §10.2.1 套用 spec 011 §7.2 1s coalesce cache;(10) §11.2 釐清 presign 不打 S3 = 不 retry;(11) §4.2 加 bucket name dot 限制;(12) §12 + §13 補 CORS e2e scope 釐清 |
| 0.4 | 2026-06-14 | 第二輪 audit 補完(1 HIGH + 2 MEDIUM):**HIGH** (1) §5.1.1 新增 `contentType → ext` 固定映射表 — `image/jpeg` 固定產 `.jpg`(避免 `.jpeg/.jpg` 同圖兩 key 錯位);**MEDIUM** (2) §3 client.ts 註明 `closeS3Client()` 由 spec 011 graceful shutdown hook 呼叫 `client.destroy()` 釋放 HTTP handler;(3) §7.4.1 新增 entity → 404 code mapping 表 + `ensureEntityExists()` service 層實作範本(TDD 不必猜該寫在哪)|
| 0.5 | 2026-06-16 | §1 加 spec 023 §2 URL prefix cross-ref(public read → `/user/v{N}`、admin write → `/cms`、auth → `/auth`);本 spec endpoint path 列為 surface 內相對路徑,實際 client URL 由 surface prefix 拼成。完整 URL mapping 表見 spec 023 §2.4。對應 backend code/test 已 cutover 至新結構 |
