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
const password = "test-only-session-switch-password"
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

async function submitInteraction(path: string, action: "login" | "consent", username = "employee01") {
  const page = await request(path, {}, true)
  expect(page.status).toBe(200)
  const text = await page.text()
  expect(text).toContain(action === "login" ? "MCP 로그인" : "조회 연결 허용")
  const csrf = text.match(/name="csrf" value="([^"]+)"/)![1]
  const values = action === "login" ? { csrf, action, username, password } : { csrf, action }
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
  directory = mkdtempSync(join(tmpdir(), "law-oauth-session-switch-"))
  const probe = createNetServer().listen(0, "127.0.0.1")
  await new Promise<void>(resolve => probe.once("listening", resolve))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  base = `http://127.0.0.1:${port}`
  for (const [key, value] of Object.entries({ NODE_ENV: "test", OAUTH_ENABLED: "1", OAUTH_ISSUER: base, OAUTH_ADMIN_IDS: "",
    OAUTH_DB_PATH: join(directory, "oauth.sqlite"), OAUTH_USERS_JSON: JSON.stringify(await Promise.all(["employee01", "employee02"].map(async id => ({ id, passwordHash: await hashPassword(password) })))),
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

async function prepareAccountSwitch(differentClient: boolean) {
  const previousClientId = clientId
  const previous = await exchange("g2b")
  if (differentClient) {
    const registration = await request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      client_name: "Separate law app", redirect_uris: [callback], response_types: ["code"], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none",
    }) })
    expect(registration.status).toBe(201)
    clientId = (await registration.json()).client_id
  }
  const { params, verifier } = authorization("law")
  const start = await request(`/oauth/authorize?${new URLSearchParams(params)}`, {}, true)
  expect(start.status).toBe(303)
  const switching = await submitInteraction(start.headers.get("location")!, "login", "employee02")
  expect(switching.status).toBe(200)
  const body = await switching.text()
  const action = body.match(/<form method="post" action="([^"]+)"/)![1]
  expect(action).toBe(`${base}/oauth/session/end/confirm`)
  const xsrf = body.match(/name="xsrf" value="([^"]+)"/)![1]
  const script = body.match(/<script>([\s\S]*?)<\/script>/)![1]
  expect(switching.headers.get("content-security-policy")).toContain(`'sha256-${createHash("sha256").update(script).digest("base64")}'`)
  return { action, xsrf, verifier, previous, previousClientId }
}
const confirm = (action: string, xsrf: string, origin = base, browser = true) => request(action, {
  ...form({ xsrf, logout: "yes" }), headers: { "content-type": "application/x-www-form-urlencoded", origin },
}, browser)

async function finishAccountSwitch(prepared: Awaited<ReturnType<typeof prepareAccountSwitch>>) {
  const submitted = await confirm(prepared.action, prepared.xsrf)
  expect(submitted.status, await submitted.clone().text()).toBe(303)
  const resumeUrl = new URL(submitted.headers.get("location")!, base)
  expect(resumeUrl.origin).toBe(base)
  expect(resumeUrl.pathname).toMatch(/^\/oauth\/authorize\//)
  const resumed = await request(resumeUrl.href, {}, true)
  expect(resumed.status, await resumed.clone().text()).toBe(303)
  const consent = await submitInteraction(resumed.headers.get("location")!, "consent")
  expect(consent.status).toBe(303)
  const location = new URL(consent.headers.get("location")!)
  expect(location.origin + location.pathname).toBe(callback)
  const exchanged = await exchangeCode(location.searchParams.get("code")!, prepared.verifier)
  expect(exchanged.status, await exchanged.clone().text()).toBe(200)
  const current = await exchanged.json()
  expect((await tools("law", current.access_token)).status).toBe(200)
  expect((await tools("g2b", prepared.previous.access_token)).status).toBe(200)
  const refreshed = await token({ client_id: prepared.previousClientId, grant_type: "refresh_token", refresh_token: prepared.previous.refresh_token })
  expect(refreshed.status, await refreshed.clone().text()).toBe(200)
  expect((await tools("g2b", (await refreshed.json()).access_token)).status).toBe(200)
  return current
}

describe("switching employee accounts in one browser", () => {
  it.each([true, false])("finishes a switch without breaking the earlier employee connection (different client: %s)", async differentClient => {
    const prepared = await prepareAccountSwitch(differentClient)
    await finishAccountSwitch(prepared)
    const metadata = await (await request("/.well-known/oauth-authorization-server")).json()
    expect(metadata.end_session_endpoint).toBeUndefined()
    expect((await request("/oauth/session/end")).status).toBe(404)
  })
  it("requires the exact origin, the browser session and its CSRF nonce", async () => {
    const prepared = await prepareAccountSwitch(true)
    expect((await confirm(prepared.action, prepared.xsrf, "https://untrusted.invalid")).status).toBe(403)
    expect((await confirm(prepared.action, prepared.xsrf, "null")).status).toBe(403)
    const withoutOrigin = await request(prepared.action, form({ xsrf: prepared.xsrf, logout: "yes" }), true)
    expect(withoutOrigin.status).toBe(403)
    expect((await confirm(prepared.action, "incorrect-nonce")).status).toBe(400)
    expect((await confirm(prepared.action, prepared.xsrf, base, false)).status).toBe(400)
    await finishAccountSwitch(prepared)
    expect((await confirm(prepared.action, prepared.xsrf)).status).toBe(400)
  })
})
