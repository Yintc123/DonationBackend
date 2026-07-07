# Spec 014:部署 / Container

| 欄位 | 內容 |
|---|---|
| 狀態 | Draft |
| 版本 | 0.2 |
| 日期 | 2026-06-13 |
| 適用範圍 | `backend/Dockerfile`、`backend/.dockerignore`、部署平台 runtime 設定、build pipeline |
| 相關 ADR | `docs/decisions/002-backend-framework.md`(Fastify)、`docs/decisions/004-auth-token-strategy.md`(Redis AOF) |
| 相關 spec | `001-environment-config.md`(env 注入)、`004-logger-module.md`(stdout JSON)、`005-error-handling.md`(process-level handler)、`006-redis-module.md`(client lifecycle)、`011-health-check.md`(K8s probe 對應)、`012-cors-and-security-headers.md`(trust proxy) |

---

## 1. 目的與範圍

### 1.1 目的

定義 backend 服務的 container 化與部署規約,使:

- 同一 image 可在 dev / stage / prod 跨平台跑,差異**只來自環境變數**(spec 001 §2)
- Container 重啟、SIGTERM、滾動更新時不掉請求、不損 cache、不錯帳
- 部署平台中立(Vercel / Railway / Fly / Render / 自架 K8s 都可接),但對 image / runtime 有共通假設

### 1.2 In scope

- Dockerfile 設計(multi-stage、base image、non-root)
- Build args / build-time metadata 注入(commit SHA、build time)
- Image tagging 策略
- Graceful shutdown 順序與 timeout
- K8s 三 probe(liveness / readiness / startup)對應 spec 011
- stdout / stderr 約定
- Secrets 注入邊界
- Resource limits 建議與 Prisma 連線池對齊

### 1.3 Out of scope

- 具體部署平台選型(Vercel vs Railway vs ...)— 留待業務上線前決定;本 spec 規範 container,不規範平台
- CDN / WAF / DDoS 防護
- Auto-scaling 策略(HPA / VPA)
- Multi-region / follower DB
- Backup / restore — 屬資料運維
- Image scanning / SBOM — 列為「開放問題」

---

## 2. 設計原則

### 2.1 三原則

1. **Image 不可變(immutable)**:同一 image hash 在所有環境跑出可預期行為;切環境改 env vars,**不**改 image
2. **Build 與 runtime 分離**:image 內**不**含 build 工具(`tsc`、devDependencies 等);build 階段失敗 fail-fast
3. **Process 即 service**:1 container = 1 Node.js process;PID 1 訊號處理由 Docker `--init`(K8s 預設啟用)提供,不裝 `tini` / supervisor

### 2.2 反模式

- 在 entrypoint 跑 `npm install` / `prisma generate`:啟動慢、版本飄、無重現性
- 跑 root user:CVE 曝險擴大
- 把 `.env` `COPY` 進 image:secret 永留 image history
- 用 `npm run dev`(`tsx watch`)作 prod entrypoint:檔案 watcher 開銷 + dev-only 行為

---

## 3. Dockerfile 結構

### 3.1 多階段草案

```dockerfile
# === Stage 1: deps — install full dependencies for build ===
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# === Stage 2: build — compile TS, generate Prisma client ===
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY . .
RUN npx prisma generate
RUN npm run build              # tsc → dist/

# === Stage 3: runtime — minimal image ===
FROM node:20-alpine AS runtime
WORKDIR /app

# Re-install ONLY production deps; drops devDependencies
COPY package.json package-lock.json ./
COPY --from=build /app/prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force
RUN npx prisma generate        # 把 client 留進 final image

COPY --from=build /app/dist ./dist

# Build metadata(由 build pipeline 注入,曝在 spec 011 health 端點)
ARG BUILD_GIT_SHA=unknown
ARG BUILD_TIMESTAMP=unknown
ARG BUILD_VERSION=unknown
ENV BUILD_GIT_SHA=$BUILD_GIT_SHA \
    BUILD_TIMESTAMP=$BUILD_TIMESTAMP \
    BUILD_VERSION=$BUILD_VERSION \
    NODE_ENV=production

# Non-root user(node:alpine 內建 `node` user, UID 1000)
USER node

EXPOSE 3001
CMD ["node", "dist/server.js"]
```

> **v0.2 — 同步實作**:實際 `backend/Dockerfile` 的 stage 命名 / 結構與上方草案不同(草案為 `deps → build → runtime` 三段流水線;實作為 **`build → deps-prod → runtime`**):
>
> - **`build`**:full deps + `apk add openssl` + `prisma generate` + `npm run build`
> - **`deps-prod`**:`npm ci --omit=dev`(不重跑 `prisma generate`;runtime 改由 `COPY --from=build /app/node_modules/.prisma` 還原被 `--omit=dev` 抹掉的 client artifacts)
> - **`runtime`**:`COPY` package.json + prisma + `deps-prod` 的 node_modules + build 的 `.prisma` + `dist/`,並**額外 `COPY --from=build /app/src ./src`**——`prisma db seed`(一次性 ECS task,ADR 010)以 `tsx` 跑 `prisma/seed.ts`、其 import 解析到 `/app/src/*.js`,故 source tree 需隨 `dist/` 一起 ship(應用本身 `node dist/server.js` 不觸及 `/app/src`)
> - 三個 stage 皆顯式 `RUN apk add --no-cache openssl`(見 §3.2 備註)

### 3.2 為何 alpine

| 角度 | alpine | distroless | slim(debian) |
|---|---|---|---|
| Image size | ~50MB | ~80MB | ~120MB |
| Debug 友善 | ✅ `sh` / `apk add` | ❌ 無 shell | ✅ |
| libc | musl(部分 native module 雷區) | glibc | glibc |
| Prisma engine | 已內建必要 binary(v0.2 — 同步實作:`openssl` **並非開箱可用**,Dockerfile 三個 stage 皆顯式 `RUN apk add --no-cache openssl`,否則 `prisma generate` libssl 偵測失敗、runtime `migrate` 會嘗試下載引擎並在非 root `node` user 下失敗)| 開箱即用 | 開箱即用 |

選 **alpine** 主因:size + debug 友善;Prisma 在 alpine 的 native binary 已穩定。若未來引入需要 glibc 的 native module(`canvas` / `sharp` 等),改 `node:20-slim`。

### 3.3 `.dockerignore`

```
node_modules
dist
coverage
.env
.env.*
.git
.github
docs
README.md
CLAUDE.md
tests
*.log
```

- 排除 `.env*`:絕不進 image
- 排除 `docs / tests / .github`:減少 image 體積與洩漏面
- 排除 `.git`:含 history,屬攻擊面

---

## 4. Build 與 Image Tagging

### 4.1 標籤策略

| 標籤 | 何時推 | 用途 |
|---|---|---|
| `<registry>/jkodonation-backend:<git-sha>` | 每次 main 成功 build | 不可變、可追溯 |
| `<registry>/jkodonation-backend:<env>`(`stage` / `prod`) | `<env>` deploy 成功後 | mutable 指針,方便快速 rollback(指回前一個 sha) |
| `<registry>/jkodonation-backend:latest` | **不使用** | 來源歧義、誤用易出事 |

### 4.2 Build args 注入

```bash
docker build \
  --build-arg BUILD_GIT_SHA=$(git rev-parse HEAD) \
  --build-arg BUILD_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --build-arg BUILD_VERSION=$(node -p "require('./package.json').version") \
  -t <registry>/jkodonation-backend:$(git rev-parse HEAD) \
  .
```

三項 metadata 由 runtime `process.env.BUILD_*` 取得,曝在 spec 011 health 端點的 `version` 區段(讓 ops 能驗證「現在跑的是哪個 commit」)。

---

## 5. Graceful Shutdown

### 5.1 觸發訊號

| 訊號 | 來源 | 行為 |
|---|---|---|
| `SIGTERM` | K8s / `docker stop` / 平台 rolling deploy | 進入 graceful drain |
| `SIGINT` | `Ctrl+C`(dev) | 同 SIGTERM |
| `SIGKILL` | 平台 timeout 後強制 | 無法捕捉;靠 timeout 設定避免 |

### 5.2 序列(對齊 spec 011 §9)

```
T=0      SIGTERM received
         ├─ 翻 readiness flag = false       (spec 011:probe 開始失敗)
         │
         ▼
T=2s     Wait readiness grace period(讓 LB 從 pool 移除)
         │
         ▼
         fastify.close()                    (停接新請求 + 等 in-flight)
         │  └─ 觸發 onClose hooks:
         │       ├─ prisma.$disconnect()
         │       └─ redis.quit()
         │
         │  └─ 守備計時器:force-exit 28s(FORCE_EXIT_MS,寫死常數)
         │
         ▼
T≤28s    process.exit(0)
```

> **v0.2 — 同步實作**:`src/server.ts:19-20` 用**寫死常數** `SHUTDOWN_DRAIN_GRACE_MS = 2_000` + `FORCE_EXIT_MS = 28_000`,**非** env。§5.2 舊圖引用的 `SHUTDOWN_DRAIN_TIMEOUT` 環境變數**不存在**。實際序列:翻 readiness gate → 等 2s drain grace → `app.close()`(內含 onClose disconnect/quit)→ 成功則 `exit(0)`;另有 28s force-exit `.unref()` 守備(`server.ts:53-56`)。

### 5.3 Timeout 設定

| 名稱 | 預設 | 範圍 / 規則 |
|---|---|---|
| Readiness drain grace | 2s | 1-5s,需大於 LB probe interval(`server.ts:19` `SHUTDOWN_DRAIN_GRACE_MS`,寫死常數) |
| Fastify in-flight timeout | 25s(**未實作**) | v0.2 — 同步實作:`app.close()` **未**設 in-flight 上限,靠下方 28s force-exit 兜底;若要精確 25s 需另接 `closeGracefulTimeout` / 自訂計時器 |
| Force exit | 28s | `server.ts:20` `FORCE_EXIT_MS`(寫死),`setTimeout(...).unref()` 守備;比 K8s grace(30s)少 2s 緩衝 |
| K8s `terminationGracePeriodSeconds` | 30s | 由 deployment manifest 設定 |

### 5.4 實作位置

- `src/server.ts` 啟動後註冊 `process.on('SIGTERM' | 'SIGINT', handler)`
- handler 內呼叫 `app.close()`(Fastify 會跑所有 `onClose` hooks,含 `prisma.$disconnect()` / `redis.quit()`)
- 加 `setTimeout(() => process.exit(1), forceExitMs).unref()` 守備
- 不在 handler 內手動 `prisma.$disconnect()`:由 plugin 註冊的 `onClose` 統一處理(spec 003 §4.1 / spec 006 client lifecycle)

### 5.5 程式錯誤造成的 exit

- `unhandledRejection` / `uncaughtException`(spec 005 §11):log + `process.exit(1)`,**不**嘗試自我修復
- 由 container runtime / K8s 重啟即可

---

## 6. K8s Probe 接線

### 6.1 對應 spec 011

| Probe | 端點 | 失敗動作 | 建議參數 |
|---|---|---|---|
| **startup** | `GET /health/startup` | 容器初始化未完成,延後其他 probe | initialDelay: 0, periodSeconds: 2, failureThreshold: 30(60s 預算) |
| **readiness** | `GET /health/ready` | 從 LB 移除;**不重啟** | periodSeconds: 5, timeoutSeconds: 2, failureThreshold: 2 |
| **liveness** | `GET /health/live` | **重啟容器** | periodSeconds: 30, timeoutSeconds: 3, failureThreshold: 3 |

### 6.2 範例(K8s manifest 片段)

```yaml
containers:
  - name: backend
    image: <registry>/jkodonation-backend:<git-sha>
    ports:
      - containerPort: 3001
    startupProbe:
      httpGet: { path: /health/startup, port: 3001 }
      initialDelaySeconds: 0
      periodSeconds: 2
      failureThreshold: 30
    readinessProbe:
      httpGet: { path: /health/ready, port: 3001 }
      periodSeconds: 5
      timeoutSeconds: 2
      failureThreshold: 2
    livenessProbe:
      httpGet: { path: /health/live, port: 3001 }
      periodSeconds: 30
      timeoutSeconds: 3
      failureThreshold: 3
    terminationGracePeriodSeconds: 30
```

### 6.3 平台無 K8s(Vercel / Railway / Fly)

- 多數平台只有「healthcheck」單一概念,對應到 `/health/ready` 即可
- 自行於 platform UI 設定 `/health/ready`,間隔對齊 §6.1
- liveness 由平台「容器是否回應」推斷,不一定可細調

### 6.4 與 readiness gate 連動

- shutdown 序列(§5.2)第一步**翻 readiness flag = false**
- 該 flag 由 spec 011 owner 模組維護;`/health/ready` 讀取後回 503
- 翻 flag 與真正關連線之間預留 2s drain grace,讓 LB 完成移除

---

## 7. 日誌

### 7.1 約定(對齊 spec 004)

- **唯一輸出: stdout**(`fd 1`),format: pino JSON line per record
- error 也走 stdout(非 stderr),簡化 log 收集 pipeline
- **不寫檔**:`/app/logs/` 不存在,任何 attempt 視為 bug
- 容器 runtime 負責 log 收集 / rotate / 上傳

### 7.2 各環境 LOG_LEVEL

- prod:`LOG_LEVEL=warn`
- stage:`LOG_LEVEL=info`
- dev:`LOG_LEVEL=debug`(本機,不在 image 預設值)

---

## 8. Secrets 注入

### 8.1 規則(對齊 spec 001 §5)

- **絕不**在 build 階段 `ARG` / `ENV` / `COPY` 帶 secret — 會永留 image history
- 高敏感 secret(`JWT_*_SECRET`、`DB_PASSWORD`、`GOOGLE_CLIENT_SECRET`)由 secret manager **在 runtime** 注入到容器 env
- mid-敏感(連線 URL)可放平台 env vars

### 8.2 啟動驗證

`@fastify/env` 在 `register` 階段檢查必填(spec 001 §4),缺漏 fail-fast。Container 因此**不應**進入 `CMD` 後才發現 secret 缺漏 — 若發生,fail-fast 後容器 exit code != 0,平台會視為 crashloop。

### 8.3 secret rotate

- 高敏感 secret 應週期性 rotate(由部署平台 secret manager 處理)
- rotate = 改 secret 值 + 觸發 rolling restart(`kubectl rollout restart` 或平台 redeploy)
- application 端不需感知;`@fastify/env` 重新載入

---

## 9. Resource Limits

### 9.1 建議起點

| 資源 | request | limit |
|---|---|---|
| CPU | 250m | 1000m |
| Memory | 256Mi | 512Mi |

實際值依負載 profiling 調整;上線前需做基準測試。

### 9.2 與 Prisma 連線池對齊

Prisma 預設連線數 = `num_physical_cpus * 2 + 1`。在 K8s 內**容器看到的是 host CPU 數**,而非 limit。**必須**明示設定:

- 對應 spec 001 §3.2 `DB_CONNECTION_LIMIT`
- 建議公式:`DB_CONNECTION_LIMIT = ceil(cpu_limit_cores * 2 + 1)`,例如 `cpu limit = 1` → 3
- 大於此值無收益,還會耗盡 Postgres 端 `max_connections`(各 pod 累加)

### 9.3 Node heap 與 OOM 防範

- Node.js `--max-old-space-size=$((CONTAINER_MEMORY_LIMIT_MB * 75 / 100))`(由 entrypoint 或 `NODE_OPTIONS` 動態設)
- 不依賴 Node 預設(在 container 內常超過 limit 觸發 OOMKill)

---

## 10. 開放問題

- **部署平台尚未決定** — 影響 secret manager 整合、image registry 選擇、CI/CD pipeline 樣板;待業務上線前決
- **是否引入 sidecar**(metric exporter、log shipper)— 目前單 process 即可,未來觀測性升級時考慮
- **Image scanning**(Trivy / Snyk)— 進入 CI 屬 nice-to-have,本期不導入
- **SBOM 產出**(`docker sbom`)— 同上
- **多架構 image**(amd64 + arm64)— Apple Silicon 開發者愈來愈多,值得加;builds via `docker buildx`
- **`prisma migrate deploy` 在何處跑** — 選項:(a) deploy job 前置步驟、(b) `initContainer`、(c) app 啟動時。本 spec 暫不決定,留給 CI/CD pipeline spec

---

## 11. 變更紀錄

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.2 | 2026-07-07 | **同步實作**:§5.3「Fastify in-flight timeout 25s」標**未實作**(`app.close()` 無 in-flight 上限,靠 28s force-exit 兜底);§5.2 移除不存在的 `SHUTDOWN_DRAIN_TIMEOUT` env,改記寫死常數 `SHUTDOWN_DRAIN_GRACE_MS=2s` / `FORCE_EXIT_MS=28s`(`src/server.ts:19-20`);§3.2 更正 `openssl` **非**開箱可用、三 stage 皆 `apk add openssl`;§3.1 補實際 Dockerfile stage 結構(`build → deps-prod → runtime` + runtime `COPY src/` 供 seed)|
| 0.1 | 2026-06-13 | 初版 |
