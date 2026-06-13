// Spec 004 §6.1 — request / response serializers.
//
// `req`: emit method, url, routeUrl, remoteAddress only.
//        Headers / body are intentionally dropped (PII / secret hygiene,
//        spec 004 §4.4). Redaction (§7) is a backstop, not a license.
//
// `res`: emit statusCode + latencyMs. Fastify v5's built-in response log
//        attaches `responseTime` (ms, float) on `res`; we round to an
//        integer and rename for spec compliance. Callers may also set
//        `latencyMs` explicitly (e.g. custom onResponse hook).
//
// `err`: re-export pino.stdSerializers.err — type/message/stack/code.

import pino from 'pino'

interface ReqLike {
  method?: unknown
  url?: unknown
  routeUrl?: unknown
  routerPath?: unknown
  ip?: unknown
  remoteAddress?: unknown
}

interface ResLike {
  statusCode?: unknown
  latencyMs?: unknown
  responseTime?: unknown
}

export function reqSerializer(req: ReqLike): {
  method?: unknown
  url?: unknown
  routeUrl?: unknown
  remoteAddress?: unknown
} {
  return {
    method: req.method,
    url: req.url,
    routeUrl: req.routeUrl ?? req.routerPath,
    remoteAddress: req.ip ?? req.remoteAddress,
  }
}

export function resSerializer(res: ResLike): {
  statusCode?: unknown
  latencyMs?: unknown
} {
  const latencyMs =
    typeof res.latencyMs === 'number'
      ? res.latencyMs
      : typeof res.responseTime === 'number'
        ? Math.round(res.responseTime)
        : undefined

  return {
    statusCode: res.statusCode,
    latencyMs,
  }
}

export const errSerializer = pino.stdSerializers.err
