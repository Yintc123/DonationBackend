// Spec 016 §4.1.1 / backend ADR 004 — Accept-Language parsing.

import { describe, expect, it } from 'vitest'

import { LOCALES, parseAcceptLanguage, pickLocalised, type Locale } from './locale.js'

describe('LOCALES', () => {
  it('exposes the two supported locales in canonical form', () => {
    expect([...LOCALES]).toEqual(['zh-TW', 'en'])
  })
})

describe('parseAcceptLanguage', () => {
  it('returns the default zh-TW when header is undefined', () => {
    expect(parseAcceptLanguage(undefined)).toBe<Locale>('zh-TW')
  })

  it('returns the default zh-TW when header is empty', () => {
    expect(parseAcceptLanguage('')).toBe<Locale>('zh-TW')
  })

  it('returns the default zh-TW when header lists only unsupported locales', () => {
    expect(parseAcceptLanguage('ja, ko, ar')).toBe<Locale>('zh-TW')
  })

  it('picks zh-TW when zh-TW comes before en regardless of casing', () => {
    expect(parseAcceptLanguage('ZH-tw,en')).toBe<Locale>('zh-TW')
  })

  it('picks en when only en is supported', () => {
    expect(parseAcceptLanguage('en')).toBe<Locale>('en')
  })

  it('picks en for en-US (region subtag) — primary subtag match', () => {
    expect(parseAcceptLanguage('en-US')).toBe<Locale>('en')
  })

  it('picks zh-TW for zh-Hant-TW too', () => {
    expect(parseAcceptLanguage('zh-Hant-TW')).toBe<Locale>('zh-TW')
  })

  it('returns zh-TW when a generic zh appears with no Hant/TW tag', () => {
    expect(parseAcceptLanguage('zh-CN')).toBe<Locale>('zh-TW')
  })

  it('honours quality values — higher q wins regardless of order', () => {
    expect(parseAcceptLanguage('en;q=0.5, zh-TW;q=0.9')).toBe<Locale>('zh-TW')
    expect(parseAcceptLanguage('zh-TW;q=0.3, en;q=0.8')).toBe<Locale>('en')
  })

  it('ignores entries with q=0 (explicitly rejected)', () => {
    expect(parseAcceptLanguage('zh-TW;q=0, en')).toBe<Locale>('en')
  })

  it('skips malformed q-values gracefully (uses listed order)', () => {
    expect(parseAcceptLanguage('en;q=banana, zh-TW')).toBe<Locale>('en')
  })

  it('returns the FIRST listed locale when q-values tie', () => {
    expect(parseAcceptLanguage('zh-TW, en')).toBe<Locale>('zh-TW')
    expect(parseAcceptLanguage('en, zh-TW')).toBe<Locale>('en')
  })
})

describe('pickLocalised', () => {
  it("returns the en field when locale='en' and en is set", () => {
    expect(pickLocalised('en', { zh: '中文', en: 'English' })).toBe('English')
  })

  it("falls back to zh when locale='en' but en is null", () => {
    expect(pickLocalised('en', { zh: '中文', en: null })).toBe('中文')
  })

  it("falls back to zh when locale='en' but en is undefined", () => {
    expect(pickLocalised('en', { zh: '中文', en: undefined })).toBe('中文')
  })

  it('always returns zh when locale=zh-TW (even if en exists)', () => {
    expect(pickLocalised('zh-TW', { zh: '中文', en: 'English' })).toBe('中文')
  })

  it('returns the zh field unmodified — empty string is still a value (caller checks)', () => {
    expect(pickLocalised('en', { zh: '中文', en: '' })).toBe('')
  })
})
