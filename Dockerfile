# syntax=docker/dockerfile:1.7
#
# Multi-stage build per spec 014 §3. Three stages:
#   build     — full deps + tsc + prisma generate
#   deps-prod — production-only deps (no devDependencies)
#   runtime   — minimal final image, non-root user
#
# The deps-prod / build split lets us drop devDependencies (incl. prisma CLI)
# from the final image while preserving the generated Prisma client by copying
# node_modules/.prisma from the build stage. `npm ci --omit=dev` triggers
# @prisma/client's postinstall which exits 0 when the CLI is absent.

# === Stage 1: build — compile TS, generate Prisma client ===
FROM node:20-alpine AS build
WORKDIR /app

# OpenSSL is required by Prisma to pick the correct query engine binary.
# Without it `prisma generate` warns about libssl detection and falls back
# to a guess, then at runtime `prisma migrate` tries to download the right
# engine — which fails under the non-root `node` user (read-only paths).
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN npx prisma generate
RUN npm run build

# === Stage 2: production deps only ===
FROM node:20-alpine AS deps-prod
WORKDIR /app

# OpenSSL needed during install so prisma's postinstall downloads the right
# engine binaries for this libssl version.
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

# === Stage 3: runtime — minimal image ===
FROM node:20-alpine AS runtime
WORKDIR /app

# OpenSSL needed at runtime so prisma CLI (used for `migrate deploy` from the
# one-shot migration ECS task per ADR 010) can resolve the engine without
# attempting a runtime download.
RUN apk add --no-cache openssl

# package.json is needed at runtime for Node to honor "type": "module".
COPY package.json ./
COPY --from=build /app/prisma ./prisma
COPY --from=deps-prod /app/node_modules ./node_modules
# Restore the generated Prisma client artifacts wiped by --omit=dev install.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma

COPY --from=build /app/dist ./dist

# Build metadata — injected by build pipeline (spec 014 §4.2).
ARG BUILD_GIT_SHA=unknown
ARG BUILD_TIMESTAMP=unknown
ARG BUILD_VERSION=unknown
ENV BUILD_GIT_SHA=$BUILD_GIT_SHA \
    BUILD_TIMESTAMP=$BUILD_TIMESTAMP \
    BUILD_VERSION=$BUILD_VERSION \
    NODE_ENV=production

# Non-root user — `node` is pre-created in node:20-alpine (UID 1000).
USER node

EXPOSE 3001

# Application is launched directly — Node receives SIGTERM as PID 1 for
# graceful shutdown. The Prisma client composes its own connection URL
# from discrete DB_* env via src/lib/db/compose-database-url.ts, so no
# shell wrapper is needed at runtime.
CMD ["node", "dist/server.js"]
