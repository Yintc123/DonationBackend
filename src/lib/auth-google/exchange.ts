// Spec 007 §4.2 Step 4 — Google `POST /token` exchange.
//
// We POST application/x-www-form-urlencoded to `tokenUrl` (typically
// https://oauth2.googleapis.com/token) with the authorization code, the
// PKCE verifier, and the client credentials. Google responds with at least
// `id_token` (we discard `access_token` / `refresh_token`).
//
// Error mapping (route layer → RFC 7807):
//   - 4xx upstream → ExchangeFailedError → AUTH_OAUTH_EXCHANGE_FAILED 401
//   - 5xx / network → UpstreamFailureError → UPSTREAM_FAILURE 502
//   - missing id_token → ExchangeFailedError → AUTH_OAUTH_EXCHANGE_FAILED 401

export interface ExchangeInput {
  tokenUrl: string
  code: string
  codeVerifier: string
  clientId: string
  clientSecret: string
  redirectUri: string
  fetchImpl?: typeof fetch
}

export interface ExchangeResult {
  idToken: string
  rawResponse: Record<string, unknown>
}

export class ExchangeFailedError extends Error {
  readonly status: number
  constructor(message: string, status: number, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined)
    this.name = 'ExchangeFailedError'
    this.status = status
  }
}

export class UpstreamFailureError extends Error {
  readonly status: number
  constructor(message: string, status: number, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined)
    this.name = 'UpstreamFailureError'
    this.status = status
  }
}

export async function exchangeCodeForIdToken(input: ExchangeInput): Promise<ExchangeResult> {
  const f = input.fetchImpl ?? fetch
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.codeVerifier,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
  })

  let res: Response
  try {
    res = await f(input.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    })
  } catch (err) {
    throw new UpstreamFailureError(
      `upstream request to ${input.tokenUrl} failed`,
      0,
      err,
    )
  }

  if (res.status >= 500) {
    throw new UpstreamFailureError(
      `upstream ${input.tokenUrl} responded with ${res.status}`,
      res.status,
    )
  }
  if (!res.ok) {
    throw new ExchangeFailedError(
      `oauth exchange failed: upstream responded with ${res.status}`,
      res.status,
    )
  }

  let json: Record<string, unknown>
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch (err) {
    throw new ExchangeFailedError('oauth exchange failed: response is not JSON', res.status, err)
  }

  const idToken = json.id_token
  if (typeof idToken !== 'string' || idToken.length === 0) {
    throw new ExchangeFailedError(
      'oauth exchange failed: response is missing id_token',
      res.status,
    )
  }
  return { idToken, rawResponse: json }
}
