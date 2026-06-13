import { describe, expect, it } from 'vitest'

import { parseAllowedReturnOrigins, sanitizeReturnTo } from './return-to.js'

const ctx = (origins: string) => ({ allowedOrigins: parseAllowedReturnOrigins(origins) })

describe('parseAllowedReturnOrigins', () => {
  it('splits comma-separated origins and normalises to URL.origin', () => {
    const origins = parseAllowedReturnOrigins(
      'http://localhost:3000, https://app.example.com,  https://staging.example.com:8443/  ',
    )
    expect(origins).toEqual(
      new Set(['http://localhost:3000', 'https://app.example.com', 'https://staging.example.com:8443']),
    )
  })

  it('drops malformed entries silently', () => {
    expect(parseAllowedReturnOrigins('not-a-url')).toEqual(new Set())
  })
})

describe('sanitizeReturnTo (spec 007 §13.8)', () => {
  const c = ctx('https://app.example.com,http://localhost:3000')

  it('accepts a relative path starting with single /', () => {
    expect(sanitizeReturnTo('/dashboard', c)).toBe('/dashboard')
  })

  it('REJECTS protocol-relative // (browser treats as cross-origin)', () => {
    expect(sanitizeReturnTo('//evil.com', c)).toBeUndefined()
  })

  it('accepts an http(s) URL whose origin is allowlisted', () => {
    expect(sanitizeReturnTo('https://app.example.com/foo?bar=1', c)).toBe(
      'https://app.example.com/foo?bar=1',
    )
  })

  it('REJECTS a same-host URL on a different port', () => {
    expect(sanitizeReturnTo('https://app.example.com:8443/foo', c)).toBeUndefined()
  })

  it('REJECTS an unknown origin', () => {
    expect(sanitizeReturnTo('https://evil.com/steal', c)).toBeUndefined()
  })

  it('REJECTS non-http schemes', () => {
    expect(sanitizeReturnTo('javascript:alert(1)', c)).toBeUndefined()
    expect(sanitizeReturnTo('data:text/html,<script>x</script>', c)).toBeUndefined()
  })

  it('REJECTS a path that starts with backslash', () => {
    expect(sanitizeReturnTo('\\evil.com', c)).toBeUndefined()
  })

  it('REJECTS a value with newline / CRLF (log injection)', () => {
    expect(sanitizeReturnTo('/safe\nfake', c)).toBeUndefined()
  })

  it('REJECTS empty / oversize strings', () => {
    expect(sanitizeReturnTo('', c)).toBeUndefined()
    expect(sanitizeReturnTo('/' + 'a'.repeat(2048), c)).toBeUndefined()
  })

  it('returns undefined for undefined input (pass-through)', () => {
    expect(sanitizeReturnTo(undefined, c)).toBeUndefined()
  })
})
