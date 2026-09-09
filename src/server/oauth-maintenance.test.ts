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
describe("account recovery and backups", () => {
  it("requires reauthentication for staff reset and restores account data while revoking all sessions", async () => {
    const staffTokens = await exchange()
    await adminLogin()
    let csrf = (await adminCsrf()).csrf
    expect((await request("/admin/backup", form({ csrf, currentPassword: "wrong" }), true)).status).toBe(401)
    const backup = await request("/admin/backup", form({ csrf, currentPassword: password }), true)
    expect(backup.status).toBe(200)
    expect(backup.headers.get("content-disposition")).toContain("attachment")
    const snapshot = await backup.text()
    expect(snapshot).not.toContain(staffTokens.access_token)
    expect(snapshot).not.toContain(password)
    const fields = { csrf, target: "employee01", currentPassword: password, password: "test-only-reset-password", repeat: "test-only-reset-password" }
    expect((await request("/admin/reset", form({ ...fields, target: "employee02" }), true)).status).toBe(403)
    expect((await request("/admin/reset", form({ ...fields, csrf: "forged" }), true)).status).toBe(403)
    expect((await request("/admin/reset", form(fields), true)).status).toBe(200)
    expect((await request("/mcp", { headers: { authorization: `Bearer ${staffTokens.access_token}` } })).status).toBe(401)
    const resetTokens = await exchange("employee01", false, "test-only-reset-password")
    await adminLogin()
    csrf = (await adminCsrf()).csrf
    expect((await request("/admin/employees", form({ csrf, username: "after_backup", password, repeat: password }), true)).status).toBe(303)
    const restore = async (token: string, contents = snapshot) => {
      const data = new FormData()
      data.set("csrf", token); data.set("currentPassword", password); data.set("confirmation", "복원")
      data.set("backup", new Blob([contents], { type: "application/json" }), "backup.json")
      return request("/admin/restore", { method: "POST", headers: { origin: base }, body: data }, true)
    }
    expect((await restore("forged")).status).toBe(403)
    expect((await restore(csrf, snapshot.replace(base, "https://different.example"))).status).toBe(400)
    const restored = await restore(csrf)
    expect(restored.status).toBe(200)
    expect((await request("/mcp", { headers: { authorization: `Bearer ${resetTokens.access_token}` } })).status).toBe(401)
    expect((await request("/admin", {}, true)).status).toBe(303)
    expect((await adminLogin()).status).toBe(303)
    expect((await adminCsrf()).page).not.toContain("after_backup")
    expect((await exchange()).access_token).toBeTruthy()
  }, 30000)
  it("issues a one-time recovery code without storing plaintext and consumes it on password recovery", async () => {
    await adminLogin()
    const csrf = (await adminCsrf()).csrf
    expect((await request("/admin/recovery-code", form({ csrf, currentPassword: "wrong" }), true)).status).toBe(401)
    const issued = await request("/admin/recovery-code", form({ csrf, currentPassword: password }), true)
    const code = (await issued.text()).match(/<code[^>]*>([a-f0-9]{64})<\/code>/)![1]
    const db = new DatabaseSync(join(directory, "oauth.sqlite"))
    try { expect(db.prepare("SELECT code_hash FROM admin_recovery WHERE account_id='employee02'").get()?.code_hash).not.toBe(code) } finally { db.close() }
    const recover = async (value: string) => {
      const page = await (await request("/admin/recover", {}, true)).text()
      const token = page.match(/name="csrf" value="([^"]+)"/)![1]
      return request("/admin/recover", form({ csrf: token, username: "employee02", code: value, password: "test-only-recovered-password", repeat: "test-only-recovered-password" }), true)
    }
    expect((await recover("0".repeat(64))).status).toBe(401)
    expect((await recover(code)).status).toBe(200)
    expect((await recover(code)).status).toBe(401)
    expect((await adminLogin()).status).toBe(401)
    expect((await adminLogin("employee02", "test-only-recovered-password")).status).toBe(303)
  })
})
