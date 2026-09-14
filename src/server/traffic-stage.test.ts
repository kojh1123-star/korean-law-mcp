import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer as createNetServer } from "node:net"
import type { Server as HttpServer } from "node:http"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { hashPassword } from "./oauth-accounts.js"
import { OAuthStore } from "./oauth-store.js"
import { startHTTPServer } from "./http-server.js"
import { trafficHtml } from "./admin-traffic.js"
import { trafficStage } from "./traffic.js"

describe("request stage persistence", () => {
  it("adds a stage to an existing database without losing old requests, accounts, grants or usage", async () => {
    const folder = mkdtempSync(join(tmpdir(), "traffic-stage-migration-"))
    const file = join(folder, "oauth.sqlite")
    const original = new DatabaseSync(file)
    original.exec(`CREATE TABLE recent_traffic(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,category TEXT,method TEXT,status INTEGER,auth TEXT,account_id TEXT,calls INTEGER NOT NULL);
      INSERT INTO recent_traffic VALUES(1,1700000000,'law','POST',200,'employee','staff',4);
      CREATE TABLE active_connections(account_id TEXT PRIMARY KEY,login_id TEXT NOT NULL,grant_id TEXT);
      INSERT INTO active_connections VALUES('staff','original-login','original-grant');
      CREATE TABLE employee_usage(day TEXT NOT NULL,account_id TEXT NOT NULL,calls INTEGER NOT NULL,PRIMARY KEY(day,account_id));
      INSERT INTO employee_usage VALUES('2026-09-08','staff',4);
      CREATE TABLE managed_employees(id TEXT PRIMARY KEY,password_hash TEXT,removed INTEGER NOT NULL DEFAULT 0);
      INSERT INTO managed_employees VALUES('staff','test-only-password-hash',0);`)
    original.close()
    let store = new OAuthStore(file, "http://localhost")
    try {
      expect(store.trafficSummary("all").recent[0]).toMatchObject({ stage: "legacy", calls: 4, account_id: "staff" })
      expect(trafficHtml(store, "all")).toContain("이전 기록")
      store.recordTraffic({ group: "kosis", method: "POST", status: 200, auth: "employee", accountId: "staff", calls: 0, stage: "mcp_tools_list" })
      store.recordTraffic({ group: "kosis", method: "POST", status: 200, auth: "employee", accountId: "staff", calls: 0, stage: "secret-unrecognized-method" as any })
      store.close()
      store = new OAuthStore(file, "http://localhost")
      expect(store.trafficSummary("all").recent.map(row => row.stage)).toEqual(["other", "mcp_tools_list", "legacy"])
      expect(store.loadEmployees(new Map()).get("staff")?.passwordHash).toBe("test-only-password-hash")
      expect(store.isCurrentLogin("staff", "original-login", "law")).toBe(true)
      expect(store.usageSummary("all", ["staff"]).total).toBe(4)
      expect(JSON.stringify(store.trafficSummary("all"))).not.toContain("secret-unrecognized-method")
    } finally { store.close(); rmSync(folder, { recursive: true, force: true }) }
  })

  it("never turns user supplied methods or paths into stored stage values", () => {
    expect(trafficStage("/mcp", { method: "tools/call", params: { secret: "private" } }, 401)).toBe("mcp_auth")
    expect(trafficStage("/kosis/mcp", { method: "untrusted-private-method" }, 200)).toBe("mcp_request")
    expect(trafficStage("/oauth/interaction/private-uid", { password: "private" }, 200)).toBe("oauth_interaction")
    expect(trafficStage("/oauth/request", { client_secret: "private" }, 401)).toBe("oauth_par")
    expect(trafficStage("/private-path", undefined, 404)).toBe("other")
  })
})

describe("real HTTP request stage observation", () => {
  let server: HttpServer, base: string, folder: string, file: string
  const testToken = "test-only-traffic-stage-token"
  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), "traffic-stage-http-")); file = join(folder, "oauth.sqlite")
    const probe = createNetServer().listen(0, "127.0.0.1")
    await new Promise<void>(resolve => probe.once("listening", resolve))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    base = `http://127.0.0.1:${port}`
    for (const [key, value] of Object.entries({ NODE_ENV: "test", OAUTH_ENABLED: "1", OAUTH_ISSUER: base,
      OAUTH_DB_PATH: file, OAUTH_ADMIN_IDS: "staff", OAUTH_USERS_JSON: JSON.stringify([{ id: "staff", passwordHash: await hashPassword("test-only-employee-password") }]),
      MCP_AUTH_TOKEN: testToken, MCP_HTTP_HOST: "127.0.0.1", TRUST_PROXY: "0", FALLBACK_DAILY_CAP: "1000", RATE_LIMIT_RPM: "0",
      LAW_OC: "", KOREAN_LAW_API_KEY: "", G2B_API_KEY: "", 나라장터: "", KOSIS_TOKEN: "", ACCESS_LOG: "0" })) vi.stubEnv(key, value)
    server = await startHTTPServer(() => {
      const s = new Server({ name: "stage-test", version: "1" }, { capabilities: { tools: {} } })
      s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "local_check", inputSchema: { type: "object" } }] }))
      s.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "local test only" }] }))
      return s
    }, port)
    if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve))
  }, 20000)
  afterAll(async () => {
    if (server) { server.closeIdleConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    vi.unstubAllEnvs()
    if (folder) rmSync(folder, { recursive: true, force: true })
  })

  const last = () => {
    const db = new DatabaseSync(file)
    try { return db.prepare("SELECT category,stage,status,auth,calls FROM recent_traffic ORDER BY id DESC LIMIT 1").get() }
    finally { db.close() }
  }
  const rpc = async (method: string, params: object = {}, authorized = true, notification = false) => {
    const response = await fetch(base + "/mcp?private=not-for-logs", { method: "POST", headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorized ? { authorization: `Bearer ${testToken}` } : {}),
    }, body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: 1 }), method, params }) })
    await response.text()
    return response
  }
  it("records actual initialization, readiness, tool listing and calls while keeping 401 separate", async () => {
    expect((await rpc("tools/list", {}, false)).status).toBe(401)
    expect(last()).toMatchObject({ category: "law", stage: "mcp_auth", status: 401, auth: "anonymous", calls: 0 })
    expect((await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local test", version: "1" } })).status).toBe(200)
    expect(last()).toMatchObject({ stage: "mcp_initialize", status: 200, auth: "machine" })
    expect((await rpc("notifications/initialized", {}, true, true)).status).toBe(202)
    expect(last()).toMatchObject({ stage: "mcp_initialized", status: 202 })
    expect((await rpc("tools/list")).status).toBe(200)
    expect(last()).toMatchObject({ stage: "mcp_tools_list", status: 200, calls: 0 })
    expect((await rpc("tools/call", { name: "local_check", arguments: { private: "not-for-logs" } })).status).toBe(200)
    expect(last()).toMatchObject({ stage: "mcp_tools_call", status: 200, calls: 1 })
    await rpc("untrusted-private-method")
    expect(last()).toMatchObject({ stage: "mcp_request" })
    const store = new OAuthStore(file, base)
    try {
      const rendered = trafficHtml(store, "all")
      expect(rendered).toContain("도구 목록 (tools/list)")
      expect(rendered).toContain("연결 초기화 (initialize)")
      expect(rendered).toContain("MCP 인증 필요·거절")
      expect(JSON.stringify(store.trafficSummary("all"))).not.toMatch(/not-for-logs|untrusted-private-method|test-only-traffic-stage-token/)
      expect(store.usageSummary("all", ["staff"]).total).toBe(0) // Shared token is never employee usage.
    } finally { store.close() }
  })
  it("preserves original OAuth paths after the mounted provider handles the response", async () => {
    const registration = await fetch(base + "/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      client_name: "local test", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
    }) })
    await registration.text()
    expect(registration.status).toBe(201)
    expect(last()).toMatchObject({ category: "oauth", stage: "oauth_register", status: 201 })
    const token = await fetch(base + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code" })
    await token.text()
    expect(token.status).toBeGreaterThanOrEqual(400)
    expect(last()).toMatchObject({ category: "oauth", stage: "oauth_token", status: token.status })
    const pushed = await fetch(base + "/oauth/request", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "response_type=code" })
    await pushed.text()
    expect(pushed.status).toBeGreaterThanOrEqual(400)
    expect(last()).toMatchObject({ category: "oauth", stage: "oauth_par", status: pushed.status })
    const metadata = await fetch(base + "/.well-known/oauth-protected-resource/kosis/mcp")
    await metadata.text()
    expect(metadata.status).toBe(200)
    expect(last()).toMatchObject({ stage: "oauth_metadata", status: 200 })
    const interaction = await fetch(base + "/oauth/interaction/private-uid")
    await interaction.text()
    expect(last()).toMatchObject({ stage: "oauth_interaction" })
  })
})
