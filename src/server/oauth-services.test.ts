import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { DatabaseSync } from "node:sqlite"
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
let service = "law"
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

async function startAuthorization(overrides: Record<string, string> = {}, keepCookies = false) {
  if (!keepCookies) cookieJar = new Map()
  const verifier = randomBytes(32).toString("base64url")
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: "code",
    scope: `openid offline_access ${service}:read`, resource, state: "test-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", ...overrides })
  const response = await request(`/oauth/authorize?${params}`, {}, true)
  return { verifier, response }
}
async function login(username = "employee01", keepCookies = false, overrides: Record<string, string> = {}) {
  const { verifier, response } = await startAuthorization(overrides, keepCookies)
  expect(response.status).toBe(303)
  let next = response.headers.get("location")!
  let page = await request(next, {}, true)
  expect(page.headers.get("referrer-policy")).toBe("same-origin")
  let body = await page.text()
  expect(body).toContain("MCP 로그인")
  const formPolicy = page.headers.get("content-security-policy")!.split(";").find(rule => rule.trim().startsWith("form-action "))!.trim()
  expect(formPolicy).toBe("form-action 'self' https://chatgpt.com https://claude.ai")
  const csrf = body.match(/name="csrf" value="([^"]+)"/)![1]
  let submitted = await request(next, form({ csrf, username, password, action: "login" }), true)
  expect(submitted.status).toBe(303)
  next = submitted.headers.get("location")!
  let resume = await request(next, {}, true)
  expect(resume.status).toBe(303)
  next = resume.headers.get("location")!
  page = await request(next, {}, true)
  expect(page.headers.get("referrer-policy")).toBe("same-origin")
  body = await page.text()
  expect(body).toContain("조회 연결 허용")
  expect(page.headers.get("content-security-policy")).toContain(formPolicy)
  const consentCsrf = body.match(/name="csrf" value="([^"]+)"/)![1]
  return { next, consentCsrf, verifier }
}
async function authorize(username = "employee01", keepCookies = false, overrides: Record<string, string> = {}) {
  const { next, consentCsrf, verifier } = await login(username, keepCookies, overrides)
  const submitted = await request(next, form({ csrf: consentCsrf, action: "consent" }), true)
  expect(submitted.status).toBe(303)
  const resume = await request(submitted.headers.get("location")!, {}, true)
  expect(resume.status).toBe(303)
  expect(resume.headers.get("content-security-policy")).toContain("form-action 'self' https://chatgpt.com https://claude.ai;")
  const location = new URL(resume.headers.get("location")!)
  expect(location.origin + location.pathname).toBe(callback)
  expect(location.searchParams.get("iss")).toBe(base)
  expect(location.searchParams.get("state")).toBe("test-state")
  const code = location.searchParams.get("code")!
  expect(code).toBeTruthy()
  return { code, verifier }
}
async function exchange(username = "employee01", keepCookies = false) {
  const { code, verifier } = await authorize(username, keepCookies)
  const response = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: callback, resource })
  const tokens = await response.json()
  expect(response.status).toBe(200)
  return tokens
}
async function adminLogin(username = "employee02") {
  cookieJar = new Map()
  const page = await (await request("/admin/login", {}, true)).text()
  const csrf = page.match(/name="csrf" value="([^"]+)"/)![1]
  return request("/admin/login", form({ csrf, username, password }), true)
}
async function adminCsrf() {
  const page = await (await request("/admin", {}, true)).text()
  return { page, csrf: page.match(/name="csrf" value="([^"]+)"/)![1] }
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
    OAUTH_ADMIN_IDS: "employee02",
    OAUTH_DB_PATH: join(directory, "oauth.sqlite"), OAUTH_USERS_JSON: JSON.stringify(await Promise.all(["employee01", "employee02"].map(async id => ({ id, passwordHash: await hashPassword(password) })))),
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
beforeEach(() => {
  // Independent scenarios must not consume each other's login-rate budget.
  const db = new DatabaseSync(join(directory, "oauth.sqlite"))
  try { db.exec("DELETE FROM limits") } finally { db.close() }
})
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
  if (directory) rmSync(directory, { recursive: true, force: true })
})

const choose = (s: string) => { service = s; resource = base + (s === "law" ? "/mcp" : `/${s}/mcp`) }
const rpc = (path: string, token: string, method = "tools/list", params = {}) => request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
describe("shared accounts across three services", () => {
  it.each(["law", "g2b", "kosis"])("exchanges OAuth-only %s scope without openid or offline_access", async (selected) => {
    choose(selected)
    const { code, verifier } = await authorize("employee01", false, { scope: `${selected}:read` })
    const response = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: callback, resource })
    expect(response.status, await response.clone().text()).toBe(200)
    const tokens = await response.json()
    expect((await rpc(new URL(resource).pathname, tokens.access_token)).status).toBe(200)
  })
  it.each(["law", "g2b", "kosis"])("exchanges and refreshes %s when resource is omitted at the token endpoint", async (selected) => {
    choose(selected)
    const { code, verifier } = await authorize()
    const response = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: callback })
    const body = await response.text()
    expect(response.status, body).toBe(200)
    const tokens = JSON.parse(body)
    expect((await rpc(new URL(resource).pathname, tokens.access_token)).status).toBe(200)
    const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })
    expect(refreshed.status, await refreshed.clone().text()).toBe(200)
  })
  it("keeps separate connections, checks token audience and exposes seven tools per added service", async () => {
    choose("law"); const law = await exchange()
    choose("g2b"); const g2b = await exchange()
    choose("kosis"); const kosis = await exchange()
    expect((await rpc("/mcp", law.access_token)).status).toBe(200)
    for (const [path, token, prefix] of [["/g2b/mcp", g2b.access_token, "g2b_"], ["/kosis/mcp", kosis.access_token, "kosis_"]]) {
      const r = await rpc(path, token); expect(r.status).toBe(200)
      const body = await r.json(); expect(body.result.tools).toHaveLength(7)
      expect(body.result.tools.every((t: { name: string }) => t.name.startsWith(prefix))).toBe(true)
      expect((await rpc(path, law.access_token)).status).toBe(401)
      const metadata = await (await request("/.well-known/oauth-protected-resource" + path)).json()
      expect(metadata.resource).toBe(base + path)
      expect((await request(path)).headers.get("www-authenticate")).toContain(path)
    }
    choose("g2b"); const replacement = await exchange()
    expect((await rpc("/g2b/mcp", g2b.access_token)).status).toBe(401)
    expect((await rpc("/g2b/mcp", replacement.access_token)).status).toBe(200)
    expect((await rpc("/mcp", law.access_token)).status).toBe(200)
    expect((await rpc("/kosis/mcp", kosis.access_token)).status).toBe(200)
    await rpc("/g2b/mcp", replacement.access_token, "tools/call", { name: "g2b_list_services", arguments: {} })
    await rpc("/kosis/mcp", kosis.access_token, "tools/call", { name: "kosis_classify_waste", arguments: { items: [{ name: "음식물" }] } })
    await adminLogin(); const { csrf } = await adminCsrf()
    const filtered = await (await request("/admin?service=kosis", {}, true)).text()
    expect(filtered).toContain("누적 전체 · KOSIS")
    expect(filtered).toContain("1회")
    expect((await request("/admin/access", form({ csrf, target: "employee01", services: "law" }), true)).status).toBe(303)
    expect((await rpc("/kosis/mcp", kosis.access_token)).status).toBe(401)
    expect((await rpc("/g2b/mcp", replacement.access_token)).status).toBe(401)
    expect((await rpc("/mcp", law.access_token)).status).toBe(200)
  }, 20000)
  it("rejects export through a shared machine token and validates KOSIS arguments", async () => {
    const r = await rpc("/kosis/mcp", "test-only-legacy-token", "tools/call", { name: "kosis_export_excel", arguments: {} })
    expect((await r.json()).result.isError).toBe(true)
    const bad = await rpc("/kosis/mcp", "test-only-legacy-token", "tools/call", { name: "kosis_classify_waste", arguments: { items: [], unexpected: true } })
    expect((await bad.json()).result.isError).toBe(true)
  })
})
