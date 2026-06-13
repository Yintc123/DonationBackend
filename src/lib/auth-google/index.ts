// Spec 007 — public surface of the Google OAuth / OIDC auth module.
//
// Mirrors the layout of src/lib/auth (spec 008): a Fastify plugin wires
// service deps and registers the route handlers; helpers are re-exported
// for tests / other modules.

import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

import { registerGoogleAuthRoutes } from '../../routes/auth/google.js'
import { ttlToSeconds } from '../auth/index.js'
import type { TokenSecrets } from '../auth/index.js'

import { createGoogleAuthService } from './service.js'

export {
  base64UrlEncode,
  computeCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
  timingSafeEqualStr,
} from './pkce.js'
export {
  OAUTH_SESSION_TTL_SEC,
  createOAuthSessionStore,
  type OAuthIntent,
  type OAuthSessionData,
  type OAuthSessionStore,
} from './state.js'
export {
  resolveGoogleLogin,
  resolveGoogleLink,
  type GoogleIdentity,
  type GoogleLookups,
  type GoogleLinkLookups,
  type GoogleLoginResolution,
  type GoogleLinkResolution,
} from './account-resolver.js'
export {
  IdTokenError,
  verifyGoogleIdToken,
  type GoogleJwk,
  type GoogleJwkSet,
  type GoogleVerifyOptions,
  type VerifiedGoogleIdToken,
} from './id-token.js'
export { createOidcDiscovery, type OidcDiscovery, type OidcDiscoveryOptions } from './discovery.js'
export {
  ExchangeFailedError,
  UpstreamFailureError,
  exchangeCodeForIdToken,
  type ExchangeInput,
  type ExchangeResult,
} from './exchange.js'
export {
  createGoogleAuthService,
  type GoogleAuthDeps,
  type GoogleAuthService,
  type AuthorizeInitInput,
  type AuthorizeInitOutput,
} from './service.js'

export const googleAuthPlugin = fp(
  async (app: FastifyInstance) => {
    const cfg = app.config
    const tokenSecrets: TokenSecrets = {
      accessSecret: cfg.JWT_ACCESS_SECRET,
      refreshSecret: cfg.JWT_REFRESH_SECRET,
      issuer: cfg.JWT_ISSUER,
      audience: cfg.JWT_AUDIENCE || cfg.JWT_ISSUER,
      accessTtlSec: ttlToSeconds(cfg.JWT_ACCESS_EXPIRES_IN, 10800),
      refreshTtlSec: ttlToSeconds(cfg.JWT_REFRESH_EXPIRES_IN, 2592000),
    }
    const service = createGoogleAuthService({
      prisma: app.prisma,
      redis: app.redis,
      tokenSecrets,
      googleClientId: cfg.GOOGLE_CLIENT_ID,
      googleClientSecret: cfg.GOOGLE_CLIENT_SECRET,
      googleRedirectUri: cfg.GOOGLE_CALLBACK_URL,
      oidcDiscoveryUrl: cfg.OIDC_DISCOVERY_URL,
    })
    await registerGoogleAuthRoutes(app, { service, tokenSecrets })
  },
  {
    name: 'auth-google',
    fastify: '5.x',
    dependencies: ['prisma-plugin', 'redis-plugin', 'http-response', 'rate-limit'],
  },
)
