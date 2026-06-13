// Spec 007 §10.3 / §10.5 — pure decision tree for Google login intent.
//
// The resolver receives the verified ID-token bits (sub + email) and
// abstract repository lookups (so we can test without Prisma). It returns
// one of:
//   { action: 'login',    accountId }   — existing GoogleCredential
//   { action: 'register', email, sub }  — no GoogleCredential, no email collision
//   { action: 'collision', existingAccountId } — email belongs to another account
//
// The actual mutation (create Account + GoogleCredential) is performed by
// the caller inside a single Prisma transaction (§10.4).

import { describe, expect, it } from 'vitest'

import {
  resolveGoogleLink,
  resolveGoogleLogin,
  type GoogleLinkLookups,
  type GoogleLookups,
} from './account-resolver.js'

function makeLookups(args: {
  googleCredAccount?: { id: string } | null
  emailAccount?: { id: string } | null
}): GoogleLookups {
  return {
    findAccountByGoogleSub: async () => args.googleCredAccount ?? null,
    findAccountByEmail: async () => args.emailAccount ?? null,
  }
}

describe('resolveGoogleLogin (spec 007 §10.3)', () => {
  it('should return action=login when the Google sub is already linked', async () => {
    const lookups = makeLookups({ googleCredAccount: { id: 'acct-1' } })
    const result = await resolveGoogleLogin(
      { sub: 'google-sub-xyz', email: 'alice@example.com' },
      lookups,
    )
    expect(result).toEqual({ action: 'login', accountId: 'acct-1' })
  })

  it('should return action=register when the sub is new AND email is unused', async () => {
    const lookups = makeLookups({
      googleCredAccount: null,
      emailAccount: null,
    })
    const result = await resolveGoogleLogin(
      { sub: 'google-sub-new', email: 'fresh@example.com' },
      lookups,
    )
    expect(result).toEqual({
      action: 'register',
      email: 'fresh@example.com',
      sub: 'google-sub-new',
    })
  })

  it('should return action=collision when the email is owned by an existing account without google credential (spec §10.5)', async () => {
    const lookups = makeLookups({
      googleCredAccount: null,
      emailAccount: { id: 'acct-pre-existing' },
    })
    const result = await resolveGoogleLogin(
      { sub: 'google-sub-new', email: 'taken@example.com' },
      lookups,
    )
    expect(result).toEqual({
      action: 'collision',
      existingAccountId: 'acct-pre-existing',
    })
  })

  it('should normalize the email to lowercase before lookup and in the register result', async () => {
    let observed = ''
    const lookups: GoogleLookups = {
      findAccountByGoogleSub: async () => null,
      findAccountByEmail: async (email) => {
        observed = email
        return null
      },
    }
    const result = await resolveGoogleLogin(
      { sub: 'google-sub-uc', email: 'Mixed@Example.COM' },
      lookups,
    )
    expect(observed).toBe('mixed@example.com')
    expect(result).toEqual({
      action: 'register',
      email: 'mixed@example.com',
      sub: 'google-sub-uc',
    })
  })
})

function makeLinkLookups(args: {
  linkedAccount?: { id: string } | null
  currentHasCredential?: boolean
}): GoogleLinkLookups {
  return {
    findAccountByGoogleSub: async () => args.linkedAccount ?? null,
    accountHasGoogleCredential: async () => args.currentHasCredential ?? false,
  }
}

describe('resolveGoogleLink (spec 007 §10.6)', () => {
  it('should return action=link when the sub is unlinked AND the account has no credential', async () => {
    const lookups = makeLinkLookups({
      linkedAccount: null,
      currentHasCredential: false,
    })
    const result = await resolveGoogleLink(
      'acct-current',
      { sub: 'google-sub-new', email: 'a@x.com' },
      lookups,
    )
    expect(result).toEqual({ action: 'link' })
  })

  it('should return action=already-linked-elsewhere when the sub belongs to a different account', async () => {
    const lookups = makeLinkLookups({
      linkedAccount: { id: 'acct-other' },
      currentHasCredential: false,
    })
    const result = await resolveGoogleLink(
      'acct-current',
      { sub: 'google-sub-x', email: 'a@x.com' },
      lookups,
    )
    expect(result).toEqual({ action: 'already-linked-elsewhere' })
  })

  it('should return action=credential-exists when the current account already has a Google credential', async () => {
    const lookups = makeLinkLookups({
      linkedAccount: null,
      currentHasCredential: true,
    })
    const result = await resolveGoogleLink(
      'acct-current',
      { sub: 'google-sub-y', email: 'a@x.com' },
      lookups,
    )
    expect(result).toEqual({ action: 'credential-exists' })
  })
})
