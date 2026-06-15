// Spec 019 §7.3 — JSON helpers for cache values.
//
// Cache values are stored as JSON strings (spec 006 §7.2). Two project-specific
// adjustments to vanilla JSON.stringify/parse:
//
//   1. `undefined` → `null` in objects, so optional response fields keep their
//      key (spec 016 v0.13 / spec 017 §2 「key 永遠存在」). Vanilla
//      JSON.stringify omits undefined-valued keys, which would round-trip the
//      cached body to a different shape than the source-of-truth response.
//
//   2. `Date` serialization relies on the built-in `toJSON()` (→ ISO 8601).
//      Reads do NOT reify back to Date — domain response shapes already use
//      strings.
//
// `BigInt` remains unsupported; callers must convert to string before caching
// (spec 006 §7.2 禁直接序列化 BigInt).

const undefinedToNull = (_key: string, value: unknown): unknown =>
  value === undefined ? null : value

/**
 * Serialize a value for Redis storage.
 * - `Date` → ISO string (via built-in `toJSON()`).
 * - `undefined` → `null` (preserves key presence).
 * Throws `TypeError` on `BigInt` (delegated to JSON.stringify).
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, undefinedToNull)
}

/**
 * Parse a cache-stored JSON string back into a typed value.
 * ISO date strings stay as strings; callers consume the response shape as-is.
 * Throws `SyntaxError` on malformed input (delegated to JSON.parse).
 */
export function parseJson<T>(input: string): T {
  return JSON.parse(input) as T
}
