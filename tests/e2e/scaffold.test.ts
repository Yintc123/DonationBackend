// Scaffold sanity — proves vitest e2e project is wired (config load, transform,
// setup chain). Does NOT exercise containers or MSW. Delete once first real
// e2e test lands.

import { describe, expect, it } from 'vitest'

describe('vitest e2e scaffold', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
