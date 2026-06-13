// Spec 010 §3-§12 — Fastify rate-limit plugin.
//
// Wiring:
//   - preHandler hook evaluates L1-L4 in order, short-circuiting on first
//     denial (§3.1).
//   - Layers that pass still contribute to header selection: we report the
//     "tightest" layer's limit / remaining / reset (§7.3).
//   - On denial we set the X-RateLimit-* + Retry-After headers on the reply
//     and throw TooManyRequestsError. The spec 005 errorHandler emits the
//     RFC 7807 body; Fastify preserves the headers we stamped.
//   - On Redis outage we honour RATE_LIMIT_FAILURE_MODE (closed → 503, open
//     → pass through with a warning) per §11 / §11.3.
//   - OPTIONS preflight + /health/* are skipped per §9.1 / spec 012 §3.6.

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

import {
  ServiceUnavailableError,
  TooManyRequestsError,
  ErrorCode,
} from '../errors/index.js'

import {
  resolveLayerConfig,
  type GlobalRateLimitDefaults,
  type ResolvedLayer,
  type RouteRateLimitConfig,
} from './config-resolver.js'
import { buildRateLimitHeaders, type LayerDecision } from './headers.js'
import { hashIdentifier, routeIdFromRequest } from './keys.js'
import { shouldSkipRateLimit } from './skip.js'
import { createSlidingWindowStore, type SlidingWindowStore } from './store.js'

// Augment Fastify's per-route context so handlers can declare config.rateLimit.
declare module 'fastify' {
  interface FastifyContextConfig {
    rateLimit?: RouteRateLimitConfig | false
  }
}

export interface RateLimitPluginOptions {
  /** Override the Config defaults (used by tests). */
  defaults?: Partial<GlobalRateLimitDefaults>
}

const rateLimitPluginAsync: FastifyPluginAsync<RateLimitPluginOptions> = async (
  app: FastifyInstance,
  opts,
) => {
  const log = app.log.child({ module: 'rate-limit' })
  const cfg = app.config

  const defaults: GlobalRateLimitDefaults = {
    globalPerIp: opts.defaults?.globalPerIp ?? {
      limit: cfg.RATE_LIMIT_GLOBAL_PER_IP_LIMIT,
      windowMs: cfg.RATE_LIMIT_GLOBAL_PER_IP_WINDOW_SEC * 1000,
    },
    defaultPerIp: opts.defaults?.defaultPerIp ?? {
      limit: cfg.RATE_LIMIT_DEFAULT_LIMIT,
      windowMs: cfg.RATE_LIMIT_DEFAULT_WINDOW_SEC * 1000,
    },
  }
  const failureMode = cfg.RATE_LIMIT_FAILURE_MODE

  const store: SlidingWindowStore = await createSlidingWindowStore({ redis: app.redis })

  app.addHook('preHandler', async (request, reply) => {
    // Spec §9.1 / spec 012 §3.6 — OPTIONS preflight + /health/* never count.
    if (
      shouldSkipRateLimit({
        method: request.method,
        url: request.url,
        routerPath: getRouterPath(request),
      })
    ) {
      return
    }

    const routeConfig = getRouteRateLimitConfig(request)

    // Explicit opt-out at the route level (`config.rateLimit: false`).
    if (routeConfig === false) return

    // Optional synchronous bypass (§5.1 / §9.3).
    if (routeConfig && routeConfig.bypass?.(request) === true) {
      log.debug({ event: 'rate_limit_bypass' }, 'rate limit bypassed by route predicate')
      return
    }

    const userId = extractUserId(request)
    const layers = resolveLayerConfig({
      defaults,
      routeConfig,
      hasUser: userId !== undefined,
    })

    const ip = request.ip
    const routeId = routeIdFromRequest({
      method: request.method,
      routerPath: getRouterPath(request),
      url: request.url,
    })

    const nowMs = Date.now()
    const decisions: LayerDecision[] = []

    for (const layer of layers) {
      let result
      try {
        result = await consumeLayer({ layer, request, ip, routeId, userId, nowMs, store })
      } catch (err) {
        if (failureMode === 'open') {
          log.error(
            { event: 'rate_limit_check_failed', err, layer: layer.layer },
            'rate-limit Redis call failed — failing open',
          )
          return
        }
        log.error(
          { event: 'rate_limit_redis_unavailable', err, layer: layer.layer },
          'rate-limit Redis unavailable — failing closed',
        )
        // Spec §11 — 503 with code RATE_LIMIT_UNAVAILABLE + Retry-After: 5.
        reply.header('Retry-After', '5')
        throw new ServiceUnavailableError({
          code: ErrorCode.RATE_LIMIT_UNAVAILABLE,
          message: 'Rate limit service is temporarily unavailable',
          cause: err,
        })
      }

      decisions.push({
        layer: layer.layer,
        allowed: result.allowed,
        limit: layer.limit,
        remaining: result.remaining,
        resetInMs: result.resetInMs,
      })

      // §3.1 — short-circuit on the first denial.
      if (!result.allowed) {
        const headers = buildRateLimitHeaders({ decisions, nowMs })
        applyHeaders(reply, headers)
        log.warn(
          {
            event: 'rate_limit_blocked',
            layer: layer.layer,
            limit: layer.limit,
            windowMs: layer.windowMs,
            // identifierHash is a stand-in — we hash the IP so origin can be
            // tied across blocks without leaking it (spec §11.3 / §14.2).
            identifierHash: hashIdentifier(ip),
            routeId,
          },
          'rate limit blocked',
        )
        const retryAfterSec = Number(headers['Retry-After'] ?? '1')
        throw new TooManyRequestsError({ retryAfter: retryAfterSec })
      }
    }

    // All layers passed — stamp informational headers from the tightest layer.
    const headers = buildRateLimitHeaders({ decisions, nowMs })
    applyHeaders(reply, headers)
  })
}

interface ConsumeLayerInput {
  layer: ResolvedLayer
  request: FastifyRequest
  ip: string
  routeId: string
  userId: string | undefined
  nowMs: number
  store: SlidingWindowStore
}

async function consumeLayer(c: ConsumeLayerInput) {
  switch (c.layer.layer) {
    case 'global':
      return c.store.consume({
        layer: 'global',
        windowMs: c.layer.windowMs,
        limit: c.layer.limit,
        cost: c.layer.cost,
        nowMs: c.nowMs,
        ip: c.ip,
      })
    case 'route-ip':
      return c.store.consume({
        layer: 'route-ip',
        windowMs: c.layer.windowMs,
        limit: c.layer.limit,
        cost: c.layer.cost,
        nowMs: c.nowMs,
        ip: c.ip,
        routeId: c.routeId,
      })
    case 'route-user':
      return c.store.consume({
        layer: 'route-user',
        windowMs: c.layer.windowMs,
        limit: c.layer.limit,
        cost: c.layer.cost,
        nowMs: c.nowMs,
        routeId: c.routeId,
        // userId presence is guaranteed by config-resolver when this layer exists.
        userId: c.userId!,
      })
    default: {
      // purpose:<name>
      const purposeName = c.layer.layer.slice('purpose:'.length)
      const rawIdentifier = c.layer.purposeIdentifier?.(c.request) ?? c.ip
      return c.store.consume({
        layer: 'purpose',
        windowMs: c.layer.windowMs,
        limit: c.layer.limit,
        cost: c.layer.cost,
        nowMs: c.nowMs,
        purposeName,
        identifierHash: hashIdentifier(rawIdentifier),
      })
    }
  }
}

function applyHeaders(
  reply: FastifyReply,
  headers: ReturnType<typeof buildRateLimitHeaders>,
): void {
  reply.header('X-RateLimit-Limit', headers['X-RateLimit-Limit'])
  reply.header('X-RateLimit-Remaining', headers['X-RateLimit-Remaining'])
  reply.header('X-RateLimit-Reset', headers['X-RateLimit-Reset'])
  if (headers['Retry-After']) reply.header('Retry-After', headers['Retry-After'])
  if (headers['X-RateLimit-Layer']) reply.header('X-RateLimit-Layer', headers['X-RateLimit-Layer'])
}

function getRouteRateLimitConfig(req: FastifyRequest): RouteRateLimitConfig | false | undefined {
  const cfg = req.routeOptions?.config as
    | { rateLimit?: RouteRateLimitConfig | false }
    | undefined
  const value = cfg?.rateLimit
  return value
}

function getRouterPath(req: FastifyRequest): string | undefined {
  // Fastify 5: routerPath was renamed to routeOptions.url.
  return req.routeOptions?.url
}

function extractUserId(req: FastifyRequest): string | undefined {
  // Auth integration lands in spec 007 / 008. We accept a `user` decoration
  // produced by future auth plugins; for now, undefined means anonymous.
  const user = (req as unknown as { user?: { accountId?: string; sub?: string } }).user
  if (!user) return undefined
  return user.accountId ?? user.sub
}

export const rateLimitPlugin = fp(rateLimitPluginAsync, {
  name: 'rate-limit',
  fastify: '5.x',
  // Depend on the Redis decorator (spec 006). Listed by NAME so registration
  // order in src/app.ts must put redisPlugin before this one.
  dependencies: ['redis-plugin'],
})
