import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { createHash, randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer as createNetServer } from "node:net"
import type { Server as HttpServer } from "node:http"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { hashPassword } from "./oauth-accounts.js"
import { startHTTPServer } from "./http-server.js"

const callback = "https://chatgpt.com/connector_platform_oauth_redirect"
const password = "test-only-compatibility-password"
let base: string
let server: HttpServer
let directory: string
let clientId: string
let cookies = new Map<string, string>()
const resource = (service: string) => base + (service === "law" ? "/mcp" : `/${service}/mcp`)
const form = (values: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) })

async function request(path: string, options: RequestInit = {}, browser = false) {
  const target = new URL(path, base)
  if (target.origin !== base) throw new Error("Test must not follow an external redirect.")
  const headers = new Headers(options.headers)
  if (browser) headers.set("cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "))
  const response = await fetch(target, { ...options, headers, redirect: "manual" })
  if (browser) for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";")[0]
    const split = pair.indexOf("=")
    cookies.set(pair.slice(0, split), pair.slice(split + 1))
  }
  return response
}

function authorization(service: string, extra: Record<string, string> = {}) {
  const verifier = randomBytes(32).toString("base64url")
  return { verifier, params: {
    client_id: clientId, redirect_uri: callback, response_type: "code", scope: `${service}:read`, resource: resource(service), state: "compatibility-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", ...extra,
  } }
}

async function submitInteraction(path: string, action: "login" | "consent") {
  const page = await request(path, {}, true)
  expect(page.status).toBe(200)
  const text = await page.text()
  expect(text).toContain(action === "login" ? "MCP 로그인" : "조회 연결 허용")
  const csrf = text.match(/name="csrf" value="([^"]+)"/)![1]
  const values = action === "login" ? { csrf, action, username: "employee01", password } : { csrf, action }
  const submitted = await request(path, { ...form(values), headers: { "content-type": "application/x-www-form-urlencoded", origin: base } }, true)
  expect(submitted.status).toBe(303)
  return request(submitted.headers.get("location")!, {}, true)
}

async function completeConsent(startPath: string) {
  const start = await request(startPath, {}, true)
  expect(start.status, await start.clone().text()).toBe(303)
  const loggedIn = await submitInteraction(start.headers.get("location")!, "login")
  expect(loggedIn.status).toBe(303)
  return submitInteraction(loggedIn.headers.get("location")!, "consent")
}

async function authorize(service: string, keepCookies = false) {
  if (!keepCookies) cookies = new Map()
  const { verifier, params } = authorization(service)
  const response = await completeConsent(`/oauth/authorize?${new URLSearchParams(params)}`)
  expect(response.status).toBe(303)
  const location = new URL(response.headers.get("location")!)
  expect(location.origin + location.pathname).toBe(callback)
  expect(location.searchParams.get("state")).toBe("compatibility-state")
  const code = location.searchParams.get("code")!
  expect(code).toBeTruthy()
  return { code, verifier }
}
const token = (values: Record<string, string>) => request("/oauth/token", form({ client_id: clientId, ...values }))
const exchangeCode = (code: string, verifier: string) => token({ grant_type: "authorization_code", redirect_uri: callback, code, code_verifier: verifier })
async function exchange(service: string, keepCookies = false) {
  const { code, verifier } = await authorize(service, keepCookies)
  const response = await exchangeCode(code, verifier)
  expect(response.status, await response.clone().text()).toBe(200)
  const result = await response.json()
  expect(result.scope).toBe(`${service}:read`)
  return result
}
const tools = (service: string, accessToken: string) => request(resource(service), {
  method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
})

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "law-oauth-compatibility-"))
  const probe = createNetServer().listen(0, "127.0.0.1")
  await new Promise<void>(resolve => probe.once("listening", resolve))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  base = `http://127.0.0.1:${port}`
  for (const [key, value] of Object.entries({ NODE_ENV: "test", OAUTH_ENABLED: "1", OAUTH_ISSUER: base, OAUTH_ADMIN_IDS: "",
    OAUTH_DB_PATH: join(directory, "oauth.sqlite"), OAUTH_USERS_JSON: JSON.stringify([{ id: "employee01", passwordHash: await hashPassword(password) }]),
    MCP_AUTH_TOKEN: "test-only-legacy-token", MCP_HTTP_HOST: "127.0.0.1", RATE_LIMIT_RPM: "0" })) vi.stubEnv(key, value)
  server = await startHTTPServer(() => {
    const s = new Server({ name: "compatibility-test", version: "1" }, { capabilities: { tools: {} } })
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "test_tool", inputSchema: { type: "object" } }] }))
    return s
  }, port)
  if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve))
  const registration = await request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    client_name: "ChatGPT compatibility", redirect_uris: [callback], response_types: ["code"], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none",
  }) })
  expect(registration.status).toBe(201)
  clientId = (await registration.json()).client_id
}, 20000)
beforeEach(() => {
  cookies = new Map()
  const db = new DatabaseSync(join(directory, "oauth.sqlite"))
  try { db.exec("DELETE FROM limits") } finally { db.close() }
})
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
  if (directory) rmSync(directory, { recursive: true, force: true })
})

describe("OAuth client compatibility", () => {
  it("advertises a reachable PAR route and completes PKCE authorization through it", async () => {
    const metadata = await (await request("/.well-known/oauth-authorization-server")).json()
    expect(metadata.pushed_authorization_request_endpoint).toBe(`${base}/oauth/request`)
    const { verifier, params } = authorization("g2b")
    const pushed = await request(metadata.pushed_authorization_request_endpoint, form(params))
    expect(pushed.status, await pushed.clone().text()).toBe(201)
    const { request_uri } = await pushed.json()
    const response = await completeConsent(`/oauth/authorize?${new URLSearchParams({ client_id: clientId, request_uri })}`)
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get("location")!)
    expect(location.origin + location.pathname).toBe(callback)
    expect(location.searchParams.get("state")).toBe(params.state)
    const exchanged = await exchangeCode(location.searchParams.get("code")!, verifier)
    expect(exchanged.status, await exchanged.clone().text()).toBe(200)
    const accessToken = (await exchanged.json()).access_token
    const listed = await tools("g2b", accessToken)
    expect(listed.status).toBe(200)
    expect((await listed.json()).result.tools).toHaveLength(7)
  })

  it.each(["redirect", "missing-pkce", "plain-pkce"])("PAR still rejects %s", async invalid => {
    const { params } = authorization("kosis")
    if (invalid === "redirect") params.redirect_uri = "https://unregistered.invalid/callback"
    if (invalid === "missing-pkce") delete (params as Partial<typeof params>).code_challenge
    if (invalid === "plain-pkce") params.code_challenge_method = "plain"
    const response = await request("/oauth/request", form(params))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBeTruthy()
  })

  it("rejects an incorrect PKCE verifier after consent", async () => {
    const { code } = await authorize("kosis")
    const response = await exchangeCode(code, randomBytes(32).toString("base64url"))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe("invalid_grant")
  })

  it("allows only the generated form_post callback script by its exact hash", async () => {
    const { verifier, params } = authorization("kosis", { response_mode: "form_post" })
    const response = await completeConsent(`/oauth/authorize?${new URLSearchParams(params)}`)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain(`<form method="post" action="${callback}">`)
    const script = body.match(/<script>([\s\S]*?)<\/script>/)![1]
    const hash = createHash("sha256").update(script).digest("base64")
    const csp = response.headers.get("content-security-policy")!
    expect(csp.split(";").map(rule => rule.trim()).find(rule => rule.startsWith("script-src "))).toBe(`script-src 'none' 'sha256-${hash}'`)
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("form-action 'self' https://chatgpt.com https://claude.ai")
    const code = body.match(/name="code" value="([^"]+)"/)![1]
    const exchanged = await exchangeCode(code, verifier)
    expect(exchanged.status).toBe(200)
    expect((await tools("kosis", (await exchanged.json()).access_token)).status).toBe(200)
  })

  it("keeps other services usable when one client reconnects in the same browser", async () => {
    const law = await exchange("law")
    const g2b = await exchange("g2b", true)
    const kosis = await exchange("kosis", true)
    for (const [service, credentials] of [["law", law], ["g2b", g2b], ["kosis", kosis]] as const) {
      expect((await tools(service, credentials.access_token)).status).toBe(200)
    }
    const pending = await authorize("g2b", true)
    const latest = await exchange("g2b", true)
    expect((await tools("law", law.access_token)).status).toBe(200)
    expect((await tools("kosis", kosis.access_token)).status).toBe(200)
    expect((await tools("g2b", latest.access_token)).status).toBe(200)
    expect((await tools("g2b", g2b.access_token)).status).toBe(401)
    const oldRefresh = await token({ grant_type: "refresh_token", refresh_token: g2b.refresh_token })
    expect(oldRefresh.status).toBe(400)
    expect((await oldRefresh.json()).error).toBe("invalid_grant")
    const oldCode = await exchangeCode(pending.code, pending.verifier)
    expect(oldCode.status).toBe(400)
    expect((await oldCode.json()).error).toBe("invalid_grant")
    // The rejected old credentials must not revoke either the replacement or other services.
    expect((await tools("law", law.access_token)).status).toBe(200)
    expect((await tools("kosis", kosis.access_token)).status).toBe(200)
    expect((await tools("g2b", latest.access_token)).status).toBe(200)
  })
})
