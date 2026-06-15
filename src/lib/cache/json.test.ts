// Spec 019 §7.3 — JSON helpers for cache values.
//
//   - stableStringify: Date → ISO string (toJSON default), undefined → null
//     (spec 016 v0.13 「key 永遠存在」對齊)
//   - parseJson:       typed JSON.parse; ISO strings stay strings (spec 019
//     §7.3 — domain 內已用 string,不需 reify 回 Date)

import { describe, expect, it } from 'vitest'

import { parseJson, stableStringify } from './json.js'

describe('stableStringify', () => {
  it('serializes Date via toISOString (spec 006 §7.2)', () => {
    const d = new Date('2026-06-15T00:00:00.000Z')
    expect(stableStringify({ at: d })).toBe('{"at":"2026-06-15T00:00:00.000Z"}')
  })

  it('converts undefined to null in objects (spec 016 v0.13 — key 永遠存在)', () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"a":null,"b":1}')
  })

  it('converts top-level undefined to "null"', () => {
    expect(stableStringify(undefined)).toBe('null')
  })

  it('handles undefined in arrays as null (vanilla JSON.stringify behavior)', () => {
    expect(stableStringify([1, undefined, 3])).toBe('[1,null,3]')
  })

  it('preserves null as null', () => {
    expect(stableStringify({ a: null })).toBe('{"a":null}')
  })

  it('preserves nested structures with Date + undefined', () => {
    const v = {
      id: 'abc',
      tags: ['a', 'b'],
      meta: {
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        notes: undefined,
      },
    }
    expect(stableStringify(v)).toBe(
      '{"id":"abc","tags":["a","b"],"meta":{"createdAt":"2026-01-01T00:00:00.000Z","notes":null}}',
    )
  })

  it('rejects BigInt via the underlying JSON.stringify TypeError (spec 006 §7.2)', () => {
    expect(() => stableStringify({ n: 1n })).toThrow(TypeError)
  })
})

describe('parseJson', () => {
  it('parses a JSON string into a typed object', () => {
    const out = parseJson<{ a: number }>('{"a":1}')
    expect(out).toEqual({ a: 1 })
  })

  it('round-trips with stableStringify', () => {
    const original = { id: 'x', items: [{ k: 'a' }, { k: 'b' }] }
    expect(parseJson(stableStringify(original))).toEqual(original)
  })

  it('preserves ISO string dates as strings (spec 019 §7.3 — no reify)', () => {
    const out = parseJson<{ at: string }>('{"at":"2026-06-15T00:00:00.000Z"}')
    expect(out.at).toBe('2026-06-15T00:00:00.000Z')
    expect(typeof out.at).toBe('string')
  })

  it('throws on malformed JSON', () => {
    expect(() => parseJson('not json')).toThrow(SyntaxError)
  })
})
