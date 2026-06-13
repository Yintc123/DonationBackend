// Spec 013 §8.3 — MSW handlers for external HTTP (Google OAuth /token, JWKS,
// OIDC discovery; 3rd-party webhooks). Handlers added per spec 007 when wired.

import type { RequestHandler } from 'msw'

export const googleHandlers: RequestHandler[] = []
