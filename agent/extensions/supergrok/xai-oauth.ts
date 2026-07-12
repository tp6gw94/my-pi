import { createServer } from "node:http"

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const AUTHORIZE_URL = "https://auth.x.ai/oauth2/authorize"
const TOKEN_URL = "https://auth.x.ai/oauth2/token"
const DEVICE_AUTHORIZATION_URL = "https://auth.x.ai/oauth2/device/code"
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
const SCOPE = "openid profile email offline_access grok-cli:access api:access"

const OAUTH_HOST = "127.0.0.1"
const OAUTH_PORT = 56121
const OAUTH_REDIRECT_PATH = "/callback"
export const REDIRECT_URI = `http://${OAUTH_HOST}:${OAUTH_PORT}${OAUTH_REDIRECT_PATH}`
export const XAI_BASE_URL = "https://api.x.ai/v1"

const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60 * 1000
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000

interface PkceCodes {
  verifier: string
  challenge: string
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  id_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
}

interface DeviceTokenErrorBody {
  error?: string
  error_description?: string
}

function randomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(length)))
    .map((b) => chars[b % chars.length])
    .join("")
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(buffer))
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = randomString(64)
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64UrlEncode(hash) }
}

function generateState(): string {
  return base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(32)).buffer)
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": "pi-supergrok-extension/0.1.0",
  }
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      case "'":
        return "&#39;"
      default:
        return char
    }
  })
}

function htmlSuccess(): string {
  return `<!doctype html>
<html>
  <head><title>Pi Super Grok - Authorized</title></head>
  <body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#111;color:#eee">
    <div style="text-align:center">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to Pi.</p>
    </div>
  </body>
</html>`
}

function htmlError(error: string): string {
  return `<!doctype html>
<html>
  <head><title>Pi Super Grok - Authorization Failed</title></head>
  <body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#111;color:#eee">
    <div style="text-align:center">
      <h1 style="color:#f55">Authorization Failed</h1>
      <pre style="background:#222;padding:1rem;border-radius:0.5rem">${htmlEscape(error)}</pre>
    </div>
  </body>
</html>`
}

export function buildAuthorizeUrl(pkce: PkceCodes, state: string, nonce: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state,
    nonce,
    plan: "generic",
    referrer: "pi",
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

async function exchangeCodeForTokens(code: string, pkce: PkceCodes): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`xAI token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  return (await response.json()) as TokenResponse
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`xAI token refresh failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  return (await response.json()) as TokenResponse
}

export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await fetch(DEVICE_AUTHORIZATION_URL, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`xAI device code request failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  const json = (await response.json()) as DeviceCodeResponse
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error("xAI device code response missing required fields")
  }
  return json
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function positiveSecondsToMs(value: unknown, defaultMs: number): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs
}

export async function pollDeviceCodeToken(device: DeviceCodeResponse): Promise<TokenResponse> {
  const now = () => Date.now()
  const expiresInMs = positiveSecondsToMs(device.expires_in, DEVICE_CODE_DEFAULT_EXPIRES_MS)
  const deadline = now() + expiresInMs
  let intervalMs = Math.max(
    positiveSecondsToMs(device.interval, DEVICE_CODE_DEFAULT_INTERVAL_MS),
    DEVICE_CODE_MIN_INTERVAL_MS,
  )

  while (now() < deadline) {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: authHeaders(),
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: CLIENT_ID,
        device_code: device.device_code,
      }).toString(),
    })
    if (response.ok) return (await response.json()) as TokenResponse

    const body = (await response.json().catch(() => ({}))) as DeviceTokenErrorBody
    const remaining = Math.max(0, deadline - now())

    if (body.error === "authorization_pending") {
      await defaultSleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining))
      continue
    }
    if (body.error === "slow_down") {
      intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS
      await defaultSleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining))
      continue
    }
    if (body.error === "access_denied" || body.error === "authorization_denied") {
      throw new Error("xAI device authorization was denied")
    }
    if (body.error === "expired_token") {
      throw new Error("xAI device code expired - please re-run /login supergrok")
    }
    const detail = body.error_description ?? body.error ?? ""
    throw new Error(`xAI device token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  throw new Error("xAI device authorization timed out")
}

interface PendingOAuth {
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof createServer> | undefined
let pendingOAuth: PendingOAuth | undefined

export async function startBrowserLogin(
  onAuth: (params: { url: string }) => void,
): Promise<TokenResponse> {
  if (oauthServer) {
    oauthServer.close()
    oauthServer = undefined
  }

  const pkce = await generatePKCE()
  const state = generateState()
  const nonce = generateState()
  const authUrl = buildAuthorizeUrl(pkce, state, nonce)

  const callbackPromise = waitForOAuthCallback(state)
  onAuth({ url: authUrl })

  try {
    return await callbackPromise
  } finally {
    stopOAuthServer()
  }
}

function waitForOAuthCallback(state: string): Promise<TokenResponse> {
  if (pendingOAuth) {
    pendingOAuth.reject(new Error("Superseded by a newer xAI authorize request"))
    pendingOAuth = undefined
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingOAuth) {
        pendingOAuth = undefined
        reject(new Error("xAI OAuth callback timeout"))
      }
    }, 5 * 60 * 1000)

    pendingOAuth = {
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        pendingOAuth = undefined
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        pendingOAuth = undefined
        reject(error)
      },
    }
  })
}

function stopOAuthServer(): void {
  if (oauthServer) {
    oauthServer.close()
    oauthServer = undefined
  }
}

function ensureOAuthServer(): Promise<void> {
  if (oauthServer) return Promise.resolve()

  const server = createServer((req, res) => {
    const reqUrl = req.url || "/"
    const url = new URL(reqUrl, `http://${OAUTH_HOST}:${OAUTH_PORT}`)

    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname === OAUTH_REDIRECT_PATH) {
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      const error = url.searchParams.get("error")
      const errorDescription = url.searchParams.get("error_description")

      if (error) {
        const errorMsg = errorDescription || error
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(htmlError(errorMsg))
        return
      }

      if (!code) {
        const errorMsg = "Missing authorization code"
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(htmlError(errorMsg))
        return
      }

      if (!pendingOAuth || state !== pendingOAuth.state) {
        const errorMsg = "Invalid state - potential CSRF attack"
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(htmlError(errorMsg))
        return
      }

      const current = pendingOAuth
      pendingOAuth = undefined

      exchangeCodeForTokens(code, current as unknown as PkceCodes)
        .then((tokens) => current.resolve(tokens))
        .catch((err) => current.reject(err))

      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(htmlSuccess())
      return
    }

    if (url.pathname === "/cancel") {
      pendingOAuth?.reject(new Error("Login cancelled"))
      pendingOAuth = undefined
      res.writeHead(200)
      res.end("Login cancelled")
      return
    }

    res.writeHead(404)
    res.end("Not found")
  })

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      oauthServer = undefined
      reject(err)
    }
    server.once("error", onError)
    server.listen(OAUTH_PORT, OAUTH_HOST, () => {
      server.removeListener("error", onError)
      server.on("error", () => {})
      oauthServer = server
      resolve()
    })
  })
}

// Re-export shape expected by index.ts
export interface OAuthResult {
  access_token: string
  refresh_token: string
  expires_in?: number
}

export async function loginBrowser(
  onAuth: (params: { url: string }) => void,
): Promise<OAuthResult> {
  await ensureOAuthServer()
  const tokens = await startBrowserLogin(onAuth)
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
  }
}

export async function loginDeviceCode(
  onDeviceCode: (params: {
    userCode: string
    verificationUri: string
    intervalSeconds?: number
    expiresInSeconds?: number
  }) => void,
): Promise<OAuthResult> {
  const device = await requestDeviceCode()
  onDeviceCode({
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    intervalSeconds: device.interval,
    expiresInSeconds: device.expires_in,
  })
  const tokens = await pollDeviceCodeToken(device)
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
  }
}
