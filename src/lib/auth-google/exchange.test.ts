// Spec 007 §4.2 Step 4 — Google `/token` exchange.
//
// The MSW handler asserts on form-encoded body shape so we keep parity with
// what Google actually expects (grant_type, code, code_verifier, ...).

import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { exchangeCodeForIdToken } from './exchange.js'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'

let lastBody = ''
let nextStatus = 200
let nextResponse: Record<string, unknown> = {
  id_token: 'fake-id-token',
  access_token: 'fake-access-token',
  expires_in: 3599,
  token_type: 'Bearer',
}

const handlers = [
  http.post(TOKEN_URL, async ({ request }) => {
    lastBody = await request.text()
    if (nextStatus !== 200) {
      return new HttpResponse('upstream error', { status: nextStatus })
    }
    return HttpResponse.json(nextResponse)
  }),
]

const server = setupServer(...handlers)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers(...handlers)
  lastBody = ''
  nextStatus = 200
  nextResponse = {
    id_token: 'fake-id-token',
    access_token: 'fake-access-token',
    expires_in: 3599,
    token_type: 'Bearer',
  }
})
afterAll(() => server.close())

describe('exchangeCodeForIdToken (spec 007 §4.2 Step 4)', () => {
  it('should POST grant_type / code / code_verifier / client_id / client_secret / redirect_uri (form-encoded)', async () => {
    await exchangeCodeForIdToken({
      tokenUrl: TOKEN_URL,
      code: 'authz-code-123',
      codeVerifier: 'verifier-xyz',
      clientId: 'client-abc',
      clientSecret: 'client-secret-z',
      redirectUri: 'https://app.example.com/api/auth/google/callback',
    })

    const params = new URLSearchParams(lastBody)
    expect(params.get('grant_type')).toBe('authorization_code')
    expect(params.get('code')).toBe('authz-code-123')
    expect(params.get('code_verifier')).toBe('verifier-xyz')
    expect(params.get('client_id')).toBe('client-abc')
    expect(params.get('client_secret')).toBe('client-secret-z')
    expect(params.get('redirect_uri')).toBe('https://app.example.com/api/auth/google/callback')
  })

  it('should return the id_token when Google responds 200', async () => {
    const out = await exchangeCodeForIdToken({
      tokenUrl: TOKEN_URL,
      code: 'authz-code',
      codeVerifier: 'verifier',
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'https://app.example.com/cb',
    })
    expect(out.idToken).toBe('fake-id-token')
  })

  it('should throw ExchangeFailedError when Google responds 400 (exchange failed)', async () => {
    nextStatus = 400
    await expect(
      exchangeCodeForIdToken({
        tokenUrl: TOKEN_URL,
        code: 'bad',
        codeVerifier: 'v',
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'https://app.example.com/cb',
      }),
    ).rejects.toThrow(/exchange|400/i)
  })

  it('should throw UpstreamFailureError when Google responds 5xx', async () => {
    nextStatus = 503
    await expect(
      exchangeCodeForIdToken({
        tokenUrl: TOKEN_URL,
        code: 'x',
        codeVerifier: 'v',
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'https://app.example.com/cb',
      }),
    ).rejects.toThrow(/upstream|5\d\d/i)
  })

  it('should throw when response is missing id_token', async () => {
    nextResponse = { access_token: 'a', expires_in: 1 }
    await expect(
      exchangeCodeForIdToken({
        tokenUrl: TOKEN_URL,
        code: 'x',
        codeVerifier: 'v',
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'https://app.example.com/cb',
      }),
    ).rejects.toThrow(/id_token/i)
  })
})
