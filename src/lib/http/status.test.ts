// Spec 009 §3.1 — Success HTTP Status Code dictionary.
// Only the success codes the spec explicitly enumerates are exported.

import { describe, expect, it } from 'vitest'

import { HttpStatus } from './status.js'

describe('HttpStatus', () => {
  it('should expose the success codes enumerated by spec 009 §3.1', () => {
    expect(HttpStatus.OK).toBe(200)
    expect(HttpStatus.CREATED).toBe(201)
    expect(HttpStatus.ACCEPTED).toBe(202)
    expect(HttpStatus.NO_CONTENT).toBe(204)
    expect(HttpStatus.NOT_MODIFIED).toBe(304)
  })

  it('should be a readonly object (frozen)', () => {
    expect(Object.isFrozen(HttpStatus)).toBe(true)
  })
})
