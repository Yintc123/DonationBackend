import { describe, expect, it } from 'vitest'

import { composeDatabaseUrl, type DbConfigSlice } from './compose-database-url.js'

const BASE: DbConfigSlice = {
  DB_USER: 'u',
  DB_PASSWORD: 'p',
  DB_HOST: 'db',
  DB_PORT: 5432,
  DB_NAME: 'n',
  DB_SCHEMA: 'public',
}

describe('composeDatabaseUrl', () => {
  it('returns a Postgres URL for plain values', () => {
    expect(composeDatabaseUrl(BASE)).toBe(
      'postgresql://u:p@db:5432/n?schema=public',
    )
  })

  it('percent-encodes URL-unsafe characters in the password', () => {
    expect(composeDatabaseUrl({ ...BASE, DB_PASSWORD: 'p@ss/wo:rd?#' })).toBe(
      'postgresql://u:p%40ss%2Fwo%3Ard%3F%23@db:5432/n?schema=public',
    )
  })

  it('percent-encodes URL-unsafe characters in the user', () => {
    expect(composeDatabaseUrl({ ...BASE, DB_USER: 'role@app' })).toBe(
      'postgresql://role%40app:p@db:5432/n?schema=public',
    )
  })

  it('percent-encodes the schema', () => {
    expect(composeDatabaseUrl({ ...BASE, DB_SCHEMA: 'app schema' })).toBe(
      'postgresql://u:p@db:5432/n?schema=app%20schema',
    )
  })
})
