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
async function login(username = "employee01", keepCookies = false, secret = password) {
  const { verifier, response } = await startAuthorization({}, keepCookies)
  expect(response.status).toBe(303)
  let next = response.headers.get("location")!
  let page = await request(next, {}, true)
  expect(page.headers.get("referrer-policy")).toBe("same-origin")
  let body = await page.text()
  expect(body).toContain("법령 MCP 로그인")
  const csrf = body.match(/name="csrf" value="([^"]+)"/)![1]
  let submitted = await request(next, form({ csrf, username, password: secret, action: "login" }), true)
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
async function authorize(username = "employee01", keepCookies = false, secret = password) {
  const { next, consentCsrf, verifier } = await login(username, keepCookies, secret)
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
async function exchange(username = "employee01", keepCookies = false, secret = password) {
  const { code, verifier } = await authorize(username, keepCookies, secret)
  const response = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: callback, resource })
  const tokens = await response.json()
  expect(response.status).toBe(200)
  return tokens
}
async function adminLogin(username = "employee02", secret = password) {
  cookieJar = new Map()
  const page = await (await request("/admin/login", {}, true)).text()
  const csrf = page.match(/name="csrf" value="([^"]+)"/)![1]
  return request("/admin/login", form({ csrf, username, password: secret }), true)
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


// Profile change scenarios use an isolated server and the original bootstrap environment.
describe("administrator credential changes", () => {
  it("reauthenticates, changes password and ID, revokes old connections, and survives original-env restart", async () => {
    const newPassword = "test-only-new-admin-password"
    const oldTokens = await exchange("employee02")
    const otherTokens = await exchange("employee01")
    const access = (token: string) => request("/mcp", { headers: { authorization: `Bearer ${token}` } })
    expect((await request("/admin/profile", form({}))).status).toBe(401)
    await adminLogin()
    const firstCookies = new Map(cookieJar)
    let csrf = (await adminCsrf()).csrf
    const fields = { csrf, username: "employee02", currentPassword: password, password: newPassword, repeat: newPassword }
    expect((await request("/admin/profile", form({ ...fields, csrf: "forged" }), true)).status).toBe(403)
    expect((await request("/admin/profile", { ...form(fields), headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://attacker.example" } }, true)).status).toBe(403)
    expect((await request("/admin/profile", form({ ...fields, currentPassword: "wrong-password" }), true)).status).toBe(401)
    expect((await request("/admin/profile", form({ ...fields, repeat: "different-password" }), true)).status).toBe(400)
    expect((await request("/admin/profile", form({ ...fields, username: "employee01" }), true)).status).toBe(409)
    expect((await access(oldTokens.access_token)).status).toBe(405)
    const changed = await request("/admin/profile", form(fields), true)
    expect(changed.status).toBe(200)
    expect(await changed.text()).not.toContain(newPassword)
    cookieJar = firstCookies
    expect((await request("/admin", {}, true)).status).toBe(303)
    expect((await access(oldTokens.access_token)).status).toBe(401)
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: oldTokens.refresh_token, resource })).status).toBe(400)
    expect((await access(otherTokens.access_token)).status).toBe(405)
    expect((await adminLogin()).status).toBe(401)
    expect((await adminLogin("employee02", newPassword)).status).toBe(303)
    const secondTokens = await exchange("employee02", false, newPassword)
    await adminLogin("employee02", newPassword)
    csrf = (await adminCsrf()).csrf
    const saved = new OAuthStore(join(directory, "oauth.sqlite"), base)
    try { saved.recordToolCalls("employee02", 3); saved.recordToolCalls("employee01", 1) } finally { saved.close() }
    const renameFields = { csrf, username: "renamed_admin", currentPassword: newPassword, password: "", repeat: "" }
    expect((await request("/admin/profile", form(renameFields), true)).status).toBe(200)
    expect((await access(secondTokens.access_token)).status).toBe(401)
    expect((await adminLogin("employee02", newPassword)).status).toBe(401)
    expect((await adminLogin("renamed_admin", newPassword)).status).toBe(303)
    const summary = await adminCsrf()
    expect(summary.page).toContain("renamed_admin 관리자")
    expect(summary.page).toContain("75.0%")
    expect((await request("/admin/remove", form({ csrf: summary.csrf, target: "renamed_admin", confirmTarget: "renamed_admin" }), true)).status).toBe(403)
    expect((await request("/admin/employees", form({ csrf: summary.csrf, username: "employee02", password, repeat: password }), true)).status).toBe(409)
    const newTokens = await exchange("renamed_admin", false, newPassword)
    expect((await access(newTokens.access_token)).status).toBe(405)
    // Restart with unchanged OAUTH_USERS_JSON and OAUTH_ADMIN_IDS=employee02.
    await new Promise<void>(resolve => server.close(() => resolve()))
    server = await startHTTPServer(() => new Server({ name: "profile-restart", version: "1" }, { capabilities: { tools: {} } }), Number(new URL(base).port))
    if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve))
    expect((await adminLogin("renamed_admin", newPassword)).status).toBe(303)
    expect((await adminLogin("employee02", password)).status).toBe(401)
    expect((await access(newTokens.access_token)).status).toBe(405)
    expect((await access(otherTokens.access_token)).status).toBe(405)
    const reopened = new OAuthStore(join(directory, "oauth.sqlite"), base)
    try {
      expect(reopened.resolveAccountId("employee02")).toBe("renamed_admin")
      expect(reopened.usageSummary("all", ["renamed_admin", "employee01"]).total).toBe(4)
      expect(reopened.auditLog().filter(r => r.action === "credentials")).toHaveLength(2)
    } finally { reopened.close() }
    await adminLogin("renamed_admin", newPassword)
    const concurrentCsrf = (await adminCsrf()).csrf
    const finalPassword = "test-only-final-admin-password"
    const concurrentFields = { csrf: concurrentCsrf, username: "renamed_admin", currentPassword: newPassword, password: finalPassword, repeat: finalPassword }
    const concurrent = await Promise.all([request("/admin/profile", form(concurrentFields), true), request("/admin/profile", form(concurrentFields), true)])
    expect(concurrent.map(r => r.status).sort()).toEqual([200, 401])
    expect((await adminLogin("renamed_admin", finalPassword)).status).toBe(303)
  }, 30000)
})
