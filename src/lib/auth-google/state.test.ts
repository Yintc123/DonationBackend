// Spec 007 §9.1 — sanity bounds on the OAuth session store constants.
// Full IO is exercised by tests/integration/auth-google.test.ts.

import { describe, expect, it } from 'vitest'

import { OAUTH_SESSION_TTL_SEC } from './state.js'

describe('OAuth session store (spec 007 §9.1)', () => {
  it('should expose a 600s TTL constant per spec §9.1', () => {
    expect(OAUTH_SESSION_TTL_SEC).toBe(600)
  })
})
