// Spec 012 §6.5 — X-Request-Id trust boundary (shared by spec 009's
// http-response plugin and spec 005's error handler).
//
// §6.5.1 Industry convention is "edge generates, downstream propagates":
//   Browser ──► [BFF] ──► [backend]
//                ↑ generates              accepts (this module's job)
//
// §6.5.2 Inbound ids are SAFETY-checked before reuse — failures fall back to
// Fastify's request.id:
//   Charset `[A-Za-z0-9_-]`  — defeats log injection (\r\n) and header
//                              smuggling (`:` `;` whitespace).
//   Length  16..128          — lower bound rules out low-entropy "magic
//                              ids" used to game log/metric filters;
//                              upper bound caps oversized-header DoS.
//
// §6.5.3 Format is intentionally NOT required (UUID v4, ULID, the BFF's
// `req_YYYY-MM-DD_<suffix>` all pass). The previous UUID-v4-only rule broke
// BFF correlation whenever the BFF used a non-UUID format; the security
// concerns the strict rule defended against are already covered by charset
// + length here.

import { randomUUID } from 'node:crypto'

export const REQUEST_ID_HEADER = 'x-request-id'

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,128}$/

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_RE.test(value)
}

/**
 * Resolve the canonical request id for one HTTP request. Wired into Fastify's
 * `genReqId` so the value flows into `request.id` BEFORE the request-scoped
 * logger is created — that's what makes the pino `requestId` binding (set via
 * `requestIdLogLabel` in spec 004 §6.3) match the response header (set by
 * spec 009 §6.1's onSend hook) for the same request.
 *
 * Inputs come from `req.headers['x-request-id']`, which Node typing widens to
 * `string | string[] | undefined`. Any value that fails the §6.5.2 safety
 * check — including arrays (duplicate headers, intent ambiguous) — falls back
 * to a fresh UUID v4 so request.id is never the unfiltered client input.
 */
export function genRequestId(inbound: unknown): string {
  return isValidRequestId(inbound) ? inbound : randomUUID()
}
