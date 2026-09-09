import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createHash, randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer as createNetServer } from "node:net"
import type { Server as HttpServer } from "node:http"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { hashPassword, verifyPassword, readEmployees } from "./oauth-accounts.js"
import { OAuthStore } from "./oauth-store.js"
import { startHTTPServer } from "./http-server.js"
import { requestContext } from "../lib/session-state.js"

const callback = "https://chatgpt.com/connector_platform_oauth_redirect"
const password = "test-only-employee-password"
let base: string
let resource: string
let server: HttpServer
let directory: string
let cookieJar: Map<string, string>
let clientId: string

async function request(path: string, options: RequestInit = {}, cookies = false) {
  const target = new URL(path, base)
  if (target.origin !== base) throw new Error("Test must not follow an external redirect.")
  const headers = new Headers(options.headers)
  if (cookies) headers.set("cookie", [...cookieJar].map(([k, v]) => `${k}=${v}`).join("; "))
  const response = await fetch(target, { ...options, headers, redirect: "manual" })
  if (cookies) for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";")[0]
    const split = pair.indexOf("=")
    cookieJar.set(pair.slice(0, split), pair.slice(split + 1))
  }
  return response
}
const form = (values: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams(values) })
const tokenRequest = (values: Record<string, string>) => request("/oauth/token", { ...form({ client_id: clientId, ...values }), headers: { "content-type": "application/x-www-form-urlencoded" } })

async function startAuthorization(overrides: Record<string, string> = {}) {
  cookieJar = new Map()
  const verifier = randomBytes(32).toString("base64url")
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: "code",
    scope: "openid offline_access law:read", resource, state: "test-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", ...overrides })
  const response = await request(`/oauth/authorize?${params}`, {}, true)
  return { verifier, response }
}
async function authorize() {
  const { verifier, response } = await startAuthorization()
  expect(response.status).toBe(303)
  let next = response.headers.get("location")!
  let page = await request(next, {}, true)
  let body = await page.text()
  expect(body).toContain("법령 MCP 로그인")
  const csrf = body.match(/name="csrf" value="([^"]+)"/)![1]
  let submitted = await request(next, form({ csrf, username: "employee01", password, action: "login" }), true)
  expect(submitted.status).toBe(303)
  next = submitted.headers.get("location")!
  let resume = await request(next, {}, true)
  expect(resume.status).toBe(303)
  next = resume.headers.get("location")!
  page = await request(next, {}, true)
  body = await page.text()
  expect(body).toContain("법령 조회 연결 허용")
  const consentCsrf = body.match(/name="csrf" value="([^"]+)"/)![1]
  submitted = await request(next, form({ csrf: consentCsrf, action: "consent" }), true)
  expect(submitted.status).toBe(303)
  resume = await request(submitted.headers.get("location")!, {}, true)
  expect(resume.status).toBe(303)
  const location = new URL(resume.headers.get("location")!)
  expect(location.origin + location.pathname).toBe(callback)
  expect(location.searchParams.get("iss")).toBe(base)
  expect(location.searchParams.get("state")).toBe("test-state")
  const code = location.searchParams.get("code")!
  expect(code).toBeTruthy()
  return { code, verifier }
}
async function exchange() {
  const { code, verifier } = await authorize()
  const response = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: callback, resource })
  const tokens = await response.json()
  expect(response.status).toBe(200)
  return tokens
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "law-oauth-test-"))
  const probe = createNetServer().listen(0, "127.0.0.1")
  await new Promise<void>(resolve => probe.once("listening", resolve))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  base = `http://127.0.0.1:${port}`
  resource = `${base}/mcp`
  for (const [key, value] of Object.entries({ NODE_ENV: "test", OAUTH_ENABLED: "1", OAUTH_ISSUER: base,
    OAUTH_DB_PATH: join(directory, "oauth.sqlite"), OAUTH_USERS_JSON: JSON.stringify([{ id: "employee01", passwordHash: await hashPassword(password) }]),
    MCP_AUTH_TOKEN: "test-only-legacy-token", MCP_HTTP_HOST: "127.0.0.1", FALLBACK_DAILY_CAP: "1000", RATE_LIMIT_RPM: "0" })) vi.stubEnv(key, value)
  server = await startHTTPServer(() => {
    const s = new Server({ name: "oauth-test", version: "1" }, { capabilities: { tools: {} } })
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "test_context", inputSchema: { type: "object" } }] }))
    s.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: JSON.stringify({ apiKey: requestContext.getStore()?.apiKey ?? null }) }] }))
    return s
  }, port)
  if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve))
  const registration = await request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    client_name: "ChatGPT", redirect_uris: [callback], response_types: ["code"], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none",
  }) })
  const client = await registration.json()
  expect(registration.status).toBe(201)
  clientId = client.client_id
}, 20000)
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
  if (directory) rmSync(directory, { recursive: true, force: true })
})

describe("ChatGPT OAuth authentication", () => {
  it("publishes public discovery and a 401 metadata challenge", async () => {
    const prm = await (await request("/.well-known/oauth-protected-resource/mcp")).json()
    expect(prm.resource).toBe(resource)
    expect(prm.authorization_servers).toEqual([base])
    const as = await (await request("/.well-known/oauth-authorization-server")).json()
    expect(as.issuer).toBe(base)
    expect(as.code_challenge_methods_supported).toEqual(["S256"])
    expect(as.authorization_response_iss_parameter_supported).toBe(true)
    expect(as.registration_endpoint).toBe(`${base}/oauth/register`)
    const missing = await request("/mcp")
    expect(missing.status).toBe(401)
    expect(missing.headers.get("www-authenticate")).toContain("oauth-protected-resource")
  })
  it("rejects arbitrary redirect URLs at registration", async () => {
    const r = await request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://attacker.example/callback"] }) })
    expect(r.status).toBe(400)
  })
  it("rejects wrong resources and missing PKCE before login", async () => {
    for (const params of [{ resource: "https://attacker.example/mcp" }, { code_challenge: "", code_challenge_method: "" }]) {
      const { response } = await startAuthorization(params)
      expect(response.headers.get("location") || await response.text()).toMatch(/invalid_(target|request)/)
    }
  })
  it("requires the interaction cookie, CSRF value, correct origin and password", async () => {
    const { response } = await startAuthorization()
    const location = response.headers.get("location")!
    const page = await (await request(location, {}, true)).text()
    const csrf = page.match(/name="csrf" value="([^"]+)"/)![1]
    const fields = { csrf, username: "employee01", password, action: "login" }
    expect((await request(location, form({ ...fields, csrf: "0".repeat(64) }), true)).status).toBe(403)
    expect((await request(location, { ...form(fields), headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://attacker.example" } }, true)).status).toBe(403)
    expect((await request(location, form({ ...fields, password: "wrong" }), true)).status).toBe(401)
    expect((await request(location, form(fields), false)).status).toBeGreaterThanOrEqual(400)
  })
  it("runs login, consent, PKCE exchange and MCP call without sending OAuth to the law API", async () => {
    const tokens = await exchange()
    expect(tokens.access_token).toBeTruthy()
    expect(tokens.refresh_token).toBeTruthy()
    const r = await request("/mcp", { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "test_context", arguments: {} } }) })
    expect(r.status).toBe(200)
    const result = await r.json()
    expect(JSON.parse(result.result.content[0].text).apiKey).toBeNull()
    const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource })
    expect(refreshed.status).toBe(200)
    const fresh = await refreshed.json()
    expect(fresh.refresh_token).not.toBe(tokens.refresh_token)
    const replay = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource })
    expect(replay.status).toBe(400)
  })
  it("rejects a wrong PKCE verifier and replay of a used code", async () => {
    const { code, verifier } = await authorize()
    const fields = { grant_type: "authorization_code", code, redirect_uri: callback, resource }
    expect((await tokenRequest({ ...fields, code_verifier: "x".repeat(43) })).status).toBe(400)
    expect((await tokenRequest({ ...fields, code_verifier: verifier })).status).toBe(200)
    expect((await tokenRequest({ ...fields, code_verifier: verifier })).status).toBe(400)
  })
  it("retains legacy token access and rejects fabricated bearer tokens", async () => {
    expect((await request("/mcp", { headers: { authorization: "Bearer test-only-legacy-token" } })).status).toBe(405)
    expect((await request("/mcp", { headers: { "x-mcp-token": "test-only-legacy-token" } })).status).toBe(405)
    expect((await request("/mcp", { headers: { authorization: "Bearer invented-token" } })).status).toBe(401)
  })
  it("revokes an access token through the OAuth revocation endpoint", async () => {
    const tokens = await exchange()
    expect((await request("/oauth/revoke", { ...form({ client_id: clientId, token: tokens.access_token }), headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(200)
    expect((await request("/mcp", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401)
  })
  it("checks scope, audience, expiration and password-change revocation for stored tokens", async () => {
    const tokens = await exchange()
    const store = new OAuthStore(join(directory, "oauth.sqlite"), base)
    try {
      const adapter = new (store.adapter())("AccessToken")
      const saved = await adapter.find(tokens.access_token)
      expect(saved).toBeTruthy()
      const call = () => request("/mcp", { headers: { authorization: `Bearer ${tokens.access_token}` } })
      await adapter.upsert(tokens.access_token, { ...saved!, scope: "other:read" }, 900)
      expect((await call()).status).toBe(403)
      await adapter.upsert(tokens.access_token, { ...saved!, aud: "https://wrong.example/mcp" }, 900)
      expect((await call()).status).toBe(401)
      await adapter.upsert(tokens.access_token, { ...saved!, exp: Math.floor(Date.now() / 1000) - 100 }, 900)
      expect((await call()).status).toBe(401)
      await adapter.upsert(tokens.access_token, saved!, 900)
      expect((await call()).status).toBe(405)
      store.synchronizeAccounts({ employee01: "changed-password-fingerprint" })
      expect((await call()).status).toBe(401)
    } finally { store.close() }
  })
})

describe("credentials and persistent OAuth storage", () => {
  it("hashes passwords with different salts and rejects malformed account configuration", async () => {
    const one = await hashPassword(password)
    expect(one).not.toContain(password)
    expect(await hashPassword(password)).not.toBe(one)
    expect(await verifyPassword(password, one)).toBe(true)
    expect(await verifyPassword("wrong", one)).toBe(false)
    expect(() => readEmployees('[{"id":"employee01","passwordHash":"plaintext"}]')).toThrow()
    expect(() => readEmployees("[]")).toThrow()
  })
  it("persists client registrations and keys; atomically consumes codes; revokes removed accounts", async () => {
    const path = join(directory, "adapter.sqlite")
    let store = new OAuthStore(path, base)
    const keys = store.keys()
    store.synchronizeAccounts({ employee01: "hash1" })
    const Client = new (store.adapter())("Client")
    await Client.upsert("client", { client_id: "client" })
    const Code = new (store.adapter())("AuthorizationCode")
    await Code.upsert("code", { grantId: "grant", accountId: "employee01" }, 120)
    const results = await Promise.allSettled([Code.consume("code"), Code.consume("code")])
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1)
    store.close()
    store = new OAuthStore(path, base)
    expect(store.keys()).toEqual(keys)
    expect(await new (store.adapter())("Client").find("client")).toBeTruthy()
    store.synchronizeAccounts({})
    expect(await new (store.adapter())("AuthorizationCode").find("code")).toBeUndefined()
    store.close()
    expect(() => new OAuthStore(path, "https://wrong-issuer.example")).toThrow(/issuer/)
  })
})
