// Spec 012 — barrel for the security module.
//
// Re-export the two Fastify plugins (cors, helmet) and the origin parser
// so consumers can wire them up with a single import path.
//
// Registration order in src/app.ts MUST be helmet → cors (spec 012 §4 +
// comment in src/lib/security/cors.ts): helmet's headers should also appear
// on the CORS preflight 204 response.

export { corsPlugin } from './cors.js'
export { helmetPlugin } from './helmet.js'
export {
  CorsOriginConfigError,
  parseCorsOrigin,
  type CorsOriginConfig,
} from './parse-origin.js'
