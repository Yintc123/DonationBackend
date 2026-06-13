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

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

# === Stage 3: runtime — minimal image ===
FROM node:20-alpine AS runtime
WORKDIR /app

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
CMD ["node", "dist/server.js"]
