// Spec 004 §6.2 — request/response autolog with path exclusions.
//
// Fastify's built-in autologging fires for EVERY request; under K8s with
// 5s liveness probes that's noise + I/O cost. We disable the built-in via
// `disableRequestLogging: true` at construction (see createLogger) and
// register a custom hook here that mirrors Fastify's two log lines, except
// for paths the spec excludes.

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

const HEALTH_PREFIX = '/health/'

export function shouldSkipRequestLog(req: Pick<FastifyRequest, 'method' | 'url' | 'routeOptions'>): boolean {
  // CORS preflight — explicitly exempt per spec 012 §3.6 + spec 004 §6.1.
  if (req.method === 'OPTIONS') return true
  // Health probes — spec 011 §11.3 / spec 004 §6.1 (matched on /health/ AND
  // bare /health for diagnostic endpoints if added later).
  const routeUrl = req.routeOptions?.url
  if (typeof routeUrl === 'string' && (routeUrl === '/health' || routeUrl.startsWith(HEALTH_PREFIX))) {
    return true
  }
  // Fall back to raw URL for the case where the route hasn't been resolved
  // yet (404s never reach a route handler).
  return req.url === '/health' || req.url.startsWith(HEALTH_PREFIX)
}

const loggerPolicyPluginAsync: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('onRequest', async (req) => {
    if (shouldSkipRequestLog(req)) return
    req.log.info({ req }, 'incoming request')
  })

  app.addHook('onResponse', async (req, reply) => {
    if (shouldSkipRequestLog(req)) return
    req.log.info(
      { res: reply, responseTime: reply.elapsedTime },
      'request completed',
    )
  })
}

export const loggerPolicyPlugin = fp(loggerPolicyPluginAsync, {
  name: 'logger-policy',
  fastify: '5.x',
})
