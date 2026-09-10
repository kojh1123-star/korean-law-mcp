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

const callback = "https://claude.ai/api/mcp/auth_callback"
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
    scope: `${service}:read offline_access`, resource, state: "test-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", ...overrides })
  const response = await request(`/oauth/authorize?${params}`, {}, true)
  return { verifier, response }
}
async function login(username = "employee01", keepCookies = false) {
  const { verifier, response } = await startAuthorization({}, keepCookies)
  expect(response.status).toBe(303)
  let next = response.headers.get("location")!
  let page = await request(next, {}, true)
  expect(page.headers.get("referrer-policy")).toBe("same-origin")
  let body = await page.text()
  expect(body).toContain("MCP 로그인")
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
  const consentCsrf = body.match(/name="csrf" value="([^"]+)"/)![1]
  return { next, consentCsrf, verifier }
}
async function authorize(username = "employee01", keepCookies = false) {
  const { next, consentCsrf, verifier } = await login(username, keepCookies)
  const submitted = await request(next, form({ csrf: consentCsrf, action: "consent" }), true)
  expect(submitted.status).toBe(303)
  const resume = await request(submitted.headers.get("location")!, {}, true)
  expect(resume.status).toBe(303)
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
    client_name: "Claude", redirect_uris: [callback], response_types: ["code"], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none",
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

describe("Claude and live request accounting", () => {
  it("registers Claude and completes OAuth without openid, resource-bound tool listing, and token refresh", async () => {
    for (const name of ["law", "g2b", "kosis"]) {
      choose(name)
      const token = await exchange()
      expect((await rpc(new URL(resource).pathname, token.access_token)).status).toBe(200)
      const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: token.refresh_token, resource })
      expect(refreshed.status).toBe(200)
      const tokens = await refreshed.json()
      expect(tokens.refresh_token).toBeTruthy()
      expect((await rpc(new URL(resource).pathname, tokens.access_token)).status).toBe(200)
    }
    const bad = await request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://claude.ai.attacker.example/api/mcp/auth_callback"] }) })
    expect(bad.status).toBe(400)
  }, 20000)
  it("counts rejected requests and shared-token calls separately while employee calls change the dashboard percentages", async () => {
    choose("law")
    const first = await exchange("employee01"), second = await exchange("employee02")
    await request("/health")
    expect((await rpc("/mcp", "invalid")).status).toBe(401)
    const blocked = await request("/mcp", { method: "POST", headers: { origin: "https://attacker.example", "content-type": "application/json" }, body: "{}" })
    expect(blocked.status).toBe(403)
    const malformed = await request("/mcp", { method: "POST", headers: { authorization: "Bearer test-only-legacy-token", "content-type": "application/json" }, body: "{" })
    expect(malformed.status).toBe(400)
    const tool = { name: "test_context", arguments: {} }
    await rpc("/mcp", "test-only-legacy-token", "tools/call", tool)
    for (let i = 0; i < 3; i++) await rpc("/mcp", first.access_token, "tools/call", tool)
    await rpc("/mcp", second.access_token, "tools/call", tool)
    expect((await adminLogin()).status).toBe(303)
    const page = await (await request("/admin?period=all&service=law", {}, true)).text()
    expect(page).toContain("75.0%")
    expect(page).toContain("25.0%")
    expect(page).toContain('id="live-status"')
    expect(page).toContain("5초마다 자동 갱신")
    expect(page).toContain("setInterval(refresh, 5000)")
    expect(page).toContain('공용 토큰 도구 호출 <strong>1회</strong>')
    const db = new OAuthStore(join(directory, "oauth.sqlite"), base)
    try {
      const traffic = db.trafficSummary("all")
      expect(traffic.rows.filter(r => r.category === "health").reduce((sum, r) => sum + Number(r.requests), 0)).toBe(1)
      expect(Number(traffic.rows.find(r => r.category === "admin")?.requests)).toBeGreaterThanOrEqual(3)
      expect(traffic.rows.some(r => r.category === "oauth" && Number(r.requests) > 0)).toBe(true)
      expect(traffic.rows.find(r => r.category === "law" && r.auth === "anonymous")!.denied).toBe(2)
      expect(traffic.rows.find(r => r.category === "law" && r.auth === "machine")!.calls).toBe(1)
      expect(traffic.rows.find(r => r.category === "law" && r.auth === "employee")!.calls).toBe(4)
      expect(JSON.stringify(traffic)).not.toContain("test-only-legacy-token")
      expect(db.usageSummary("all", ["employee01", "employee02"]).total).toBe(4)
    } finally { db.close() }
    const html = await request("/admin", {}, true)
    expect(html.headers.get("content-security-policy")).toContain("script-src 'nonce-")
    expect((await html.text()).match(/<script nonce="[A-Za-z0-9_-]+">/)).toBeTruthy()
    cookieJar = new Map()
    expect((await request("/admin?period=all", {}, true)).status).toBe(303)
  }, 15000)
})
