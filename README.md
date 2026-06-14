# JKODonation Backend

2026 全端面試作業 — Backend API。

## 技術棧

- **Runtime**: Node.js 20+
- **Framework**: [Fastify](https://fastify.dev/) (schema-driven、TypeScript 友善、高效能)
- **ORM**: [Prisma](https://www.prisma.io/)
- **Auth**: JWT stateless (`@fastify/jwt`) + Google OAuth 2.0 (`@fastify/oauth2`)
- **Cache / Rate-limit**: Redis (`@fastify/redis` + `ioredis`)
- **Schema / Validation**: TypeBox

> 框架選型理由見專案根目錄 `docs/decisions/002-backend-framework.md`。

## 架構

本服務為 **JWT stateless API**,不持有 session。Browser 端 session 由 Next.js BFF 管理。

```
Browser ──(session cookie)──> Next.js BFF ──(JWT Bearer)──> Fastify API (本專案)
```

## 開發

```bash
npm install
npm run dev      # tsx watch
npm run build    # tsc
npm run start    # node dist/server.js
```

預設啟動於 `http://localhost:3001`。

## 環境變數

複製 `.env.example` 為 `.env` 並填入:

- `PORT` — 預設 `3001`
- `DATABASE_URL` — Prisma 連線字串
- `JWT_SECRET` — JWT 簽章密鑰
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth 憑證
- `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` — Redis 連線參數(password 在 dev 留空)

## AI 使用聲明

本專案開發過程使用 [Claude Code](https://claude.com/claude-code) 輔助。

- AI 角色: 技術選型討論、ADR 撰寫、骨架生成、code review
- 人工角色: 需求理解、架構決策、實作驗收、安全審查
- 對話紀錄保存於專案根目錄 `docs/prompts/`(raw + 精選版)
