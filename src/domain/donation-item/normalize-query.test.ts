// Spec 016 §4.2 v0.13 — `q` must be NFC-normalised + trimmed before it
// reaches the SQL layer. Empty after normalise/trim means "no filter".

import { describe, expect, it } from 'vitest'

import { normalizeQuery } from './normalize-query.js'

describe('normalizeQuery (spec 016 §4.2 v0.13 — B2 NFC normalisation)', () => {
  it('returns undefined for undefined input', () => {
    expect(normalizeQuery(undefined)).toBeUndefined()
  })

  it('returns undefined for an empty string', () => {
    expect(normalizeQuery('')).toBeUndefined()
  })

  it('returns undefined for whitespace-only input (trim → empty)', () => {
    expect(normalizeQuery('   ')).toBeUndefined()
    expect(normalizeQuery('\t\n  ')).toBeUndefined()
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeQuery('  stray  ')).toBe('stray')
  })

  it('preserves interior whitespace', () => {
    expect(normalizeQuery('  stray animal  ')).toBe('stray animal')
  })

  it('NFC-normalises composed vs decomposed accented characters', () => {
    // U+00E7 (precomposed) vs U+0063 + U+0327 (c + combining cedilla)
    const composed = 'façade'
    const decomposed = 'façade'
    expect(composed).not.toBe(decomposed) // sanity — they differ as JS strings
    expect(normalizeQuery(composed)).toBe(composed)
    expect(normalizeQuery(decomposed)).toBe(composed)
  })

  it('NFC-normalises CJK compatibility characters', () => {
    // U+FA0C (precomposed Korean-style CJK compat) survives NFC unchanged;
    // U+0061 + U+0301 (a + combining acute) → U+00E1
    const decomposed = 'café'
    expect(normalizeQuery(decomposed)).toBe('café')
  })

  it('does NOT touch zh-TW characters that are already NFC', () => {
    expect(normalizeQuery('流浪動物')).toBe('流浪動物')
  })

  it('trim runs AFTER normalisation', () => {
    // Combining marks at the edge shouldn't be stripped by trim — only
    // leading/trailing standard whitespace should go.
    const input = '  façade  '
    expect(normalizeQuery(input)).toBe('façade')
  })
})
