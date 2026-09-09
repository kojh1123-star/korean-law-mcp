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
    scope: "openid offline_access law:read", resource, state: "test-state",
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
  expect(body).toContain("법령 MCP 로그인")
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
  expect(body).toContain("법령 조회 연결 허용")
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
    for (const origin of ["null", undefined]) {
      const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" }
      if (origin !== undefined) headers.origin = origin
      expect((await request(location, { ...form(fields), headers }, true)).status).toBe(403)
    }
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
  it("replaces only the same employee on successful password login and rejects old refresh tokens", async () => {
    const old = await exchange()
    const other = await exchange("employee02")
    const access = (token: string) => request("/mcp", { headers: { authorization: `Bearer ${token}` } })
    const { response } = await startAuthorization()
    const location = response.headers.get("location")!
    const page = await (await request(location, {}, true)).text()
    const csrf = page.match(/name="csrf" value="([^"]+)"/)![1]
    expect((await request(location, form({ csrf, username: "employee01", password: "wrong", action: "login" }), true)).status).toBe(401)
    expect((await access(old.access_token)).status).toBe(405)
    const pending = await login()
    // Revocation happens on password success, before clicking consent.
    expect((await access(old.access_token)).status).toBe(401)
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: old.refresh_token, resource })).status).toBe(400)
    expect((await access(other.access_token)).status).toBe(405)
    const consent = await request(pending.next, form({ csrf: pending.consentCsrf, action: "consent" }), true)
    const resumed = await request(consent.headers.get("location")!, {}, true)
    const code = new URL(resumed.headers.get("location")!).searchParams.get("code")!
    const freshResponse = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: pending.verifier, redirect_uri: callback, resource })
    expect(freshResponse.status).toBe(200)
    const fresh = await freshResponse.json()
    expect((await access(fresh.access_token)).status).toBe(405)
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: fresh.refresh_token, resource })).status).toBe(200)
  })
  it("rejects an older pending consent and unexchanged code after another login", async () => {
    const pending = await login()
    const oldCookies = new Map(cookieJar)
    const unexchanged = await authorize()
    const latest = await exchange()
    cookieJar = oldCookies
    expect((await request(pending.next, form({ csrf: pending.consentCsrf, action: "consent" }), true)).status).toBe(409)
    expect((await tokenRequest({ grant_type: "authorization_code", code: unexchanged.code, code_verifier: unexchanged.verifier, redirect_uri: callback, resource })).status).toBe(400)
    expect((await request("/mcp", { headers: { authorization: `Bearer ${latest.access_token}` } })).status).toBe(405)
  })
  it("requires a fresh password even when a previous browser session cookie exists", async () => {
    const old = await exchange()
    const current = await exchange("employee01", true)
    expect((await request("/mcp", { headers: { authorization: `Bearer ${old.access_token}` } })).status).toBe(401)
    expect((await request("/mcp", { headers: { authorization: `Bearer ${current.access_token}` } })).status).toBe(405)
    const { response } = await startAuthorization({}, true)
    const page = await (await request(response.headers.get("location")!, {}, true)).text()
    expect(page).toContain("법령 MCP 로그인")
  })
  it("revokes an access token through the OAuth revocation endpoint", async () => {
    const tokens = await exchange()
    expect((await request("/oauth/revoke", { ...form({ client_id: clientId, token: tokens.access_token }), headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(200)
    expect((await request("/mcp", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401)
  })
  it("creates employees immediately and validates input, role and request provenance", async () => {
    expect((await request("/admin/employees", form({ username: "new_employee", password, repeat: password }))).status).toBe(401)
    await adminLogin()
    const { csrf } = await adminCsrf()
    const fields = { csrf, username: "new_employee", password, repeat: password }
    expect((await request("/admin/employees", form({ ...fields, csrf: "forged" }), true)).status).toBe(403)
    expect((await request("/admin/employees", { ...form(fields), headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://attacker.example" } }, true)).status).toBe(403)
    expect((await request("/admin/employees", form({ ...fields, username: "bad<id" }), true)).status).toBe(400)
    expect((await request("/admin/employees", form({ ...fields, password: "short", repeat: "short" }), true)).status).toBe(400)
    expect((await request("/admin/employees", form({ ...fields, repeat: "not-the-same-password" }), true)).status).toBe(400)
    expect((await request("/admin/employees", form({ ...fields, username: "employee01" }), true)).status).toBe(409)
    const results = await Promise.all([request("/admin/employees", form(fields), true), request("/admin/employees", form(fields), true)])
    expect(results.map(r => r.status).sort()).toEqual([303, 409])
    const added = await exchange("new_employee")
    expect((await request("/mcp", { headers: { authorization: `Bearer ${added.access_token}` } })).status).toBe(405)
    expect((await adminLogin("new_employee")).status).toBe(401)
    const db = new DatabaseSync(join(directory, "oauth.sqlite"))
    try {
      const row = db.prepare("SELECT password_hash FROM managed_employees WHERE id='new_employee'").get()!
      expect(row.password_hash).not.toBe(password)
      expect(await verifyPassword(password, String(row.password_hash))).toBe(true)
      expect(db.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE target='new_employee' AND action='create'").get()?.count).toBe(1)
    } finally { db.close() }
  })
  it("removes a new employee, revokes access and pending consent, and protects administrator accounts", async () => {
    await adminLogin()
    let csrf = (await adminCsrf()).csrf
    expect((await request("/admin/employees", form({ csrf, username: "remove_employee", password, repeat: password }), true)).status).toBe(303)
    expect((await request("/admin/employees", form({ csrf, username: "pending_employee", password, repeat: password }), true)).status).toBe(303)
    const old = await exchange("remove_employee")
    const pending = await login("pending_employee")
    const pendingCookies = new Map(cookieJar)
    await adminLogin()
    csrf = (await adminCsrf()).csrf
    const fields = { csrf, target: "remove_employee", confirmTarget: "remove_employee" }
    expect((await request("/admin/remove?target=employee02", {}, true)).status).toBe(403)
    expect((await request("/admin/remove", form({ ...fields, target: "employee02", confirmTarget: "employee02" }), true)).status).toBe(403)
    expect((await request("/admin/remove", form({ ...fields, csrf: "forged" }), true)).status).toBe(403)
    expect((await request("/admin/remove", { ...form(fields), headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://attacker.example" } }, true)).status).toBe(403)
    expect((await request("/admin/remove", form({ ...fields, confirmTarget: "wrong" }), true)).status).toBe(400)
    expect((await request("/admin/remove?target=remove_employee", {}, true)).status).toBe(200)
    const persisted = new OAuthStore(join(directory, "oauth.sqlite"), base)
    try { persisted.recordToolCalls("remove_employee", 2) } finally { persisted.close() }
    expect((await request("/mcp", { headers: { authorization: `Bearer ${old.access_token}` } })).status).toBe(405)
    expect((await request("/admin/remove", form(fields), true)).status).toBe(303)
    expect((await adminCsrf()).page).toContain("remove_employee (등록 해제)")
    expect((await request("/admin/employees", form({ csrf, username: "remove_employee", password, repeat: password }), true)).status).toBe(409)
    expect((await request("/mcp", { headers: { authorization: `Bearer ${old.access_token}` } })).status).toBe(401)
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: old.refresh_token, resource })).status).toBe(400)
    expect((await request("/admin/remove", form({ csrf, target: "pending_employee", confirmTarget: "pending_employee" }), true)).status).toBe(303)
    cookieJar = pendingCookies
    expect((await request(pending.next, form({ csrf: pending.consentCsrf, action: "consent" }), true)).status).toBe(400)
    const attempt = await startAuthorization()
    const path = attempt.response.headers.get("location")!
    const loginPage = await (await request(path, {}, true)).text()
    const loginCsrf = loginPage.match(/name="csrf" value="([^"]+)"/)![1]
    expect((await request(path, form({ csrf: loginCsrf, username: "remove_employee", password, action: "login" }), true)).status).toBe(401)
    const db = new DatabaseSync(join(directory, "oauth.sqlite"))
    try {
      expect(db.prepare("SELECT password_hash,removed FROM managed_employees WHERE id='remove_employee'").get()).toMatchObject({ password_hash: null, removed: 1 })
    } finally { db.close() }
  })
  it("counts admitted employee tool calls without counting lists, legacy access or rejected requests", async () => {
    const db = new DatabaseSync(join(directory, "oauth.sqlite"))
    try { db.exec("DELETE FROM employee_usage") } finally { db.close() }
    const first = await exchange()
    const second = await exchange("employee02")
    const call = (token: string, method = "tools/call", body?: unknown) => request("/mcp", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body || { jsonrpc: "2.0", id: 1, method, params: method === "tools/call" ? { name: "test_context", arguments: {} } : {} }),
    })
    for (let i = 0; i < 3; i++) expect((await call(first.access_token)).status).toBe(200)
    expect((await call(second.access_token)).status).toBe(200)
    expect((await call(first.access_token, "tools/list")).status).toBe(200)
    expect((await call("test-only-legacy-token")).status).toBe(200)
    expect((await call("invalid")).status).toBe(401)
    expect((await call(first.access_token, "tools/call", Array.from({ length: 100 }, (_, id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "test_context" } })))).status).toBe(429)
    const saved = new OAuthStore(join(directory, "oauth.sqlite"), base)
    try {
      expect(saved.usageSummary("all", ["employee01", "employee02"])).toMatchObject({ total: 4,
        rows: [{ id: "employee01", calls: 3, percent: 75 }, { id: "employee02", calls: 1, percent: 25 }] })
    } finally { saved.close() }
    await adminLogin()
    const { page } = await adminCsrf()
    expect(page).toContain("75.0%")
    expect(page).toContain("25.0%")
    expect((await (await request("/admin?period=today", {}, true)).text())).toContain("직원별 사용량 · 오늘")
    expect((await (await request("/admin?period=invalid", {}, true)).text())).toContain("직원별 사용량 · 누적 전체")
  })
  it("requires an explicit administrator login and rejects forged management requests", async () => {
    cookieJar = new Map()
    expect((await request("/admin", {}, true)).headers.get("location")).toBe("/admin/login")
    expect((await request("/admin/accounts", form({ target: "employee01", action: "block" }), true)).status).toBe(401)
    expect((await adminLogin("employee01")).status).toBe(401)
    const employeeTokens = await exchange()
    expect((await request("/admin", { headers: { authorization: `Bearer ${employeeTokens.access_token}` } })).status).toBe(303)
    expect((await adminLogin()).status).toBe(303)
    const { page, csrf } = await adminCsrf()
    expect(page).toContain("통합 MCP 계정 관리")
    expect(page).not.toContain(password)
    expect(page).not.toContain("scrypt-v1")
    expect(page).not.toContain(employeeTokens.access_token)
    const fields = { csrf, target: "employee01", action: "block" }
    expect((await request("/admin/accounts", form({ ...fields, csrf: "forged" }), true)).status).toBe(403)
    expect((await request("/admin/accounts", { ...form(fields), headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://attacker.example" } }, true)).status).toBe(403)
    expect((await request("/admin/accounts", form({ ...fields, target: "employee02" }), true)).status).toBe(403)
    expect((await request("/admin/accounts", form({ ...fields, target: "unknown" }), true)).status).toBe(404)
    expect((await request("/mcp", { headers: { authorization: `Bearer ${employeeTokens.access_token}` } })).status).toBe(405)
    expect((await request("/admin/logout", form({ csrf }), true)).status).toBe(303)
    expect((await request("/admin/accounts", form(fields), true)).status).toBe(401)
  })
  it("lets an administrator disconnect, block and unblock one employee immediately", async () => {
    const old = await exchange()
    const other = await exchange("employee02")
    const access = (value: string) => request("/mcp", { headers: { authorization: `Bearer ${value}` } })
    await access(old.access_token)
    expect((await adminLogin()).status).toBe(303)
    const adminCookies = new Map(cookieJar)
    const { page, csrf } = await adminCsrf()
    expect(page).toContain("최근 5분 요청 계정")
    const act = async (action: string) => {
      cookieJar = new Map(adminCookies)
      return request("/admin/accounts", form({ csrf, target: "employee01", action }), true)
    }
    expect((await act("disconnect")).status).toBe(303)
    expect((await access(old.access_token)).status).toBe(401)
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: old.refresh_token, resource })).status).toBe(400)
    expect((await access(other.access_token)).status).toBe(405)
    const reconnected = await exchange()
    expect((await access(reconnected.access_token)).status).toBe(405)
    expect((await act("block")).status).toBe(303)
    expect((await access(reconnected.access_token)).status).toBe(401)
    const { response } = await startAuthorization()
    const next = response.headers.get("location")!
    const loginPage = await (await request(next, {}, true)).text()
    const loginCsrf = loginPage.match(/name="csrf" value="([^"]+)"/)![1]
    expect((await request(next, form({ csrf: loginCsrf, username: "employee01", password, action: "login" }), true)).status).toBe(401)
    const reopened = new OAuthStore(join(directory, "oauth.sqlite"), base)
    try {
      expect(reopened.isBlocked("employee01")).toBe(true)
      expect(reopened.connectionSummary("employee01").connected).toBe(false)
      expect(reopened.auditLog()[0]).toMatchObject({ actor: "employee02", target: "employee01", action: "block" })
      expect(() => reopened.beginLogin("employee01")).toThrow()
    } finally { reopened.close() }
    expect((await act("unblock")).status).toBe(303)
    expect((await access(reconnected.access_token)).status).toBe(401)
    const fresh = await exchange()
    expect((await access(fresh.access_token)).status).toBe(405)
    expect((await access(other.access_token)).status).toBe(405)
  })
  it("rejects login CSRF and invalidates older administrator sessions", async () => {
    cookieJar = new Map()
    const p = await (await request("/admin/login", {}, true)).text()
    const csrf = p.match(/name="csrf" value="([^"]+)"/)![1]
    expect((await request("/admin/login", form({ csrf: "forged", username: "employee02", password }), true)).status).toBe(403)
    expect((await request("/admin/login", { ...form({ csrf, username: "employee02", password }), headers: { "content-type": "application/x-www-form-urlencoded", origin: "null" } }, true)).status).toBe(403)
    await adminLogin()
    const oldCookies = new Map(cookieJar)
    await adminLogin()
    const newCookies = new Map(cookieJar)
    cookieJar = oldCookies
    expect((await request("/admin", {}, true)).status).toBe(303)
    cookieJar = newCookies
    expect((await request("/admin", {}, true)).status).toBe(200)
    const db = new DatabaseSync(join(directory, "oauth.sqlite"))
    try { db.exec("UPDATE objects SET expires=0 WHERE model='AdminSession'") } finally { db.close() }
    expect((await request("/admin", {}, true)).status).toBe(303)
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
  it("persists the latest connection and fences stale writes and consent races", async () => {
    const path = join(directory, "single-connection.sqlite")
    let store = new OAuthStore(path, base)
    try {
      const first = store.beginLogin("one")
      store.activateGrant("one", first, "old-grant")
      const grant = { accountId: "one" }
      await new (store.adapter())("Grant").upsert("old-grant", grant, 900)
      const other = store.beginLogin("two")
      store.activateGrant("two", other, "other-grant")
      await new (store.adapter())("Grant").upsert("other-grant", { accountId: "two" }, 900)
      const latest = store.beginLogin("one")
      expect(() => store.activateGrant("one", first, "late-grant")).toThrow()
      store.activateGrant("one", latest, "new-grant")
      expect(() => store.activateGrant("one", latest, "second-grant")).toThrow()
      await expect(new (store.adapter())("Grant").upsert("old-grant", grant, 900)).rejects.toThrow()
      for (const model of ["AuthorizationCode", "AccessToken", "RefreshToken"]) {
        await expect(new (store.adapter())(model).upsert("late", { accountId: "one", grantId: "old-grant" }, 900)).rejects.toThrow()
      }
      store.close()
      store = new OAuthStore(path, base)
      expect(store.isCurrentLogin("one", latest)).toBe(true)
      expect(store.isCurrentLogin("one", first)).toBe(false)
      expect(await new (store.adapter())("Grant").find("old-grant")).toBeUndefined()
      expect(await new (store.adapter())("Grant").find("other-grant")).toBeTruthy()
    } finally { store.close() }
  })
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
    store.activateGrant("employee01", store.beginLogin("employee01"), "grant")
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
