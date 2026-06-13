// Spec 008 §3.3 — Email normalization & validation (unit).

import { describe, expect, it } from 'vitest'

import { isValidEmail, MAX_EMAIL_LENGTH, normalizeEmail } from './email.js'

describe('normalizeEmail (spec 008 §3.3)', () => {
  it('lowercases the entire address', () => {
    expect(normalizeEmail('Foo.Bar@Example.COM')).toBe('foo.bar@example.com')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com')
  })

  it('preserves plus-addressing aliases (spec §3.3)', () => {
    expect(normalizeEmail('me+filter@Example.com')).toBe('me+filter@example.com')
  })

  it('throws when over RFC 5321 max length (254)', () => {
    const local = 'a'.repeat(245)
    const tooLong = `${local}@example.com` // 245 + 12 = 257 chars
    expect(() => normalizeEmail(tooLong)).toThrow(/length/i)
  })
})

describe('isValidEmail (spec 008 §3.3)', () => {
  it('accepts well-formed addresses', () => {
    expect(isValidEmail('alice@example.com')).toBe(true)
    expect(isValidEmail('a.b+c@sub.example.co.uk')).toBe(true)
  })

  it('rejects strings without an @', () => {
    expect(isValidEmail('not-an-email')).toBe(false)
  })

  it('rejects strings with empty local or domain', () => {
    expect(isValidEmail('@example.com')).toBe(false)
    expect(isValidEmail('alice@')).toBe(false)
  })

  it('rejects strings over the max length', () => {
    expect(isValidEmail('a'.repeat(MAX_EMAIL_LENGTH + 1))).toBe(false)
  })
})
