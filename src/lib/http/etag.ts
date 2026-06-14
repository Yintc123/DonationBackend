// Spec 017 §2 — ETag helpers for conditional GET on detail endpoints.
//
// `buildETag` produces a strong RFC 7232 ETag from the project's canonical
// signal-tuple: `id + updatedAt [+ parent.updatedAt for nested] + locale`.
// We hash all segments together (separated by ASCII 0x1F so adjacency
// collisions like `("ab","c") vs ("a","bc")` cannot occur), take the first
// 16 hex chars of the sha256, and wrap in double quotes.
//
// `ifNoneMatch` honours RFC 7232 §3.2:
//   - comma-separated lists are compared entry-by-entry (whitespace trimmed)
//   - the wildcard `*` always matches an existing representation

import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'

type ETagSegment = string | number | Date | null | undefined

/** ASCII Unit Separator. Reserved for record framing; never appears in our inputs. */
const SEP = '\x1f'

export function buildETag(...segments: ETagSegment[]): string {
  const hash = createHash('sha256')
  for (const seg of segments) {
    if (seg === null) hash.update('\x00null')
    else if (seg === undefined) hash.update('\x00undef')
    else if (seg instanceof Date) hash.update(seg.toISOString())
    else hash.update(String(seg))
    hash.update(SEP)
  }
  return `"${hash.digest('hex').slice(0, 16)}"`
}

export function ifNoneMatch(req: FastifyRequest, etag: string): boolean {
  const header = req.headers['if-none-match']
  if (typeof header !== 'string' || header.length === 0) return false
  for (const raw of header.split(',')) {
    const trimmed = raw.trim()
    if (trimmed === '*' || trimmed === etag) return true
  }
  return false
}
