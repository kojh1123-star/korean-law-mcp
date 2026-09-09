import express, { type Express, type Request, type Response } from "express"
import Provider, { errors, interactionPolicy, type Configuration } from "oidc-provider"
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { OAuthStore } from "./oauth-store.js"
import { hashPassword, readEmployees, verifyPassword } from "./oauth-accounts.js"
import { installAdmin } from "./oauth-admin.js"

export const LAW_SCOPE = "law:read"
const DISCOVERY_PATHS = new Set(["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"])
const METADATA_PATHS = ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]
const CHATGPT_CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect"
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))

function html(content: string) {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>법령 MCP 연결</title>
  <style>body{font:16px/1.6 system-ui,sans-serif;background:#f3f5f8;color:#192334;margin:0;padding:48px 20px}main{max-width:430px;margin:auto;background:white;padding:32px;border-radius:16px;border:1px solid #dde3ec}h1{font-size:26px;margin:0 0 16px}label{display:block;margin:20px 0 5px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #aab5c5;border-radius:8px;font:inherit}button{margin-top:24px;background:#164eb5;color:white;border:0;border-radius:8px;padding:12px 18px;font:inherit;cursor:pointer}button[value=deny]{background:#e9edf3;color:#263343;margin-left:8px}.error{color:#a41919}small{color:#586779}</style><main>${content}</main></html>`
}

export async function installOAuth(app: Express, trustProxy: number | false, env: NodeJS.ProcessEnv = process.env) {
  const issuer = env.OAUTH_ISSUER || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : "")
  let url: URL
  try { url = new URL(issuer) } catch { throw new Error("Set OAUTH_ISSUER to the public HTTPS origin.") }
  const local = env.NODE_ENV === "test" && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)
  if ((!local && url.protocol !== "https:") || issuer !== url.origin || url.username || url.password) {
    throw new Error("OAUTH_ISSUER must be an HTTPS origin without a path or trailing slash.")
  }
  if (!local && !env.OAUTH_DB_PATH) throw new Error("Set OAUTH_DB_PATH to a Railway volume path.")
  if (!local && env.OAUTH_DB_PATH === ":memory:") throw new Error("Production OAuth requires persistent storage.")
  const employees = readEmployees(env.OAUTH_USERS_JSON)
  const adminIds = new Set((env.OAUTH_ADMIN_IDS || "").split(",").map(id => id.trim()).filter(Boolean))
  if ([...adminIds].some(id => !employees.has(id))) throw new Error("OAUTH_ADMIN_IDS must name registered employee accounts.")
  const redirects = (env.OAUTH_REDIRECT_URIS || CHATGPT_CALLBACK).split(",").map(x => x.trim())
  if (!redirects.length || redirects.some(uri => {
    try { const u = new URL(uri); return u.protocol !== "https:" || !!u.hash || !!u.username || !!u.password } catch { return true }
  })) throw new Error("OAUTH_REDIRECT_URIS must contain exact HTTPS callback URLs.")
  const resource = `${issuer}/mcp`
  const store = new OAuthStore(env.OAUTH_DB_PATH || ":memory:", issuer)
  try {
  const fingerprints = Object.fromEntries([...employees].map(([id, employee]) => [id, createHash("sha256").update(employee.passwordHash).digest("hex")]))
  store.synchronizeAccounts(fingerprints)
  const keys = store.keys()
  const dummyHash = await hashPassword("not-an-employee-password")
  const policy = interactionPolicy.base()
  // Every new connection requires a password; an old browser cookie cannot
  // silently replace the latest employee connection.
  policy.get("login")!.checks.add(new interactionPolicy.Check("employee_login", "Sign in to connect.", (_ctx) => !_ctx.oidc.result?.login))
  const configuration: Configuration = {
    adapter: store.adapter(),
    clients: [{ client_id: "chatgpt-law", client_name: "ChatGPT 법령 조회", redirect_uris: redirects,
      response_types: ["code"], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" }],
    jwks: keys.jwks,
    cookies: { keys: [keys.cookie], short: { sameSite: "lax", secure: !local, httpOnly: true }, long: { sameSite: "lax", secure: !local, httpOnly: true } },
    pkce: { required: () => true },
    responseTypes: ["code"],
    clientAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
    clientBasedCORS: (_ctx, origin, client) => client.redirectUris?.some(uri => new URL(uri).origin === origin) ?? false,
    scopes: ["openid", "offline_access", LAW_SCOPE],
    claims: { openid: ["sub"] },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true },
      revocation: { enabled: true },
      userinfo: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, requested) => {
          if (requested !== resource) throw new errors.InvalidTarget()
          return { scope: LAW_SCOPE, audience: resource, accessTokenFormat: "opaque", accessTokenTTL: 900 }
        },
      },
    },
    routes: { authorization: "/oauth/authorize", token: "/oauth/token", jwks: "/oauth/jwks",
      registration: "/oauth/register", revocation: "/oauth/revoke" },
    interactions: { policy, url: (_ctx, interaction) => `/oauth/interaction/${interaction.uid}` },
    findAccount: async (_ctx, id) => employees.has(id) && !store.isBlocked(id) ? { accountId: id, claims: async () => ({ sub: id }) } : undefined,
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    rotateRefreshToken: true,
    ttl: { AccessToken: 900, AuthorizationCode: 120, Interaction: 600, Session: 28800, Grant: 604800,
      RefreshToken: 604800, IdToken: 900 },
    // This hook runs for static clients and every registration; arbitrary redirect/remote metadata is forbidden.
    extraClientMetadata: { properties: ["law_policy"], validator: (_ctx, _key, _value, metadata) => {
      if (!Array.isArray(metadata.redirect_uris) || !metadata.redirect_uris.length
        || metadata.redirect_uris.some(uri => !redirects.includes(uri))
        || metadata.jwks_uri || metadata.sector_identifier_uri || metadata.request_uris
        || metadata.grant_types?.some(g => !["authorization_code", "refresh_token"].includes(g))
        || metadata.response_types?.some(r => r !== "code")) throw new errors.InvalidClientMetadata("Client metadata is outside the configured policy.")
    } },
    renderError: async ctx => { ctx.type = "html"; ctx.body = html("<h1>연결을 완료하지 못했습니다</h1><p>ChatGPT에서 연결을 다시 시작해주세요.</p>") },
  }
  const provider = new Provider(issuer, configuration)
  provider.proxy = trustProxy !== false
  // Do not print exception bodies: authorization parameters may contain credentials.
  provider.on("server_error", () => console.error("[oauth] OAuth request failed."))
  const callback = provider.callback()
  const csrf = (uid: string) => createHmac("sha256", keys.cookie).update(`interaction:${uid}`).digest("hex")
  const formParser = express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 8 })
  installAdmin(app, { issuer, local, employees, store, secret: keys.cookie, dummyHash, adminIds })

  app.use((req, res, next) => {
    if (!req.path.startsWith("/oauth/") && !DISCOVERY_PATHS.has(req.path) && !METADATA_PATHS.includes(req.path)) return next()
    res.setHeader("Cache-Control", "no-store")
    // no-referrer makes browsers send Origin: null on HTML form POSTs,
    // which conflicts with the exact-origin CSRF check below. Keep the origin
    // for our own login/consent forms while withholding referrers off-site.
    res.setHeader("Referrer-Policy", "same-origin")
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("X-Frame-Options", "DENY")
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
    if (!local && (req.get("host") !== url.host || req.protocol !== "https")) return res.status(400).send("Invalid OAuth origin.")
    const ip = req.ip || req.socket.remoteAddress || "unknown"
    const bucket = createHash("sha256").update(ip).digest("hex")
    if (!store.hit(`requests:${bucket}`, 180, 60)) { res.setHeader("Retry-After", "60"); return res.status(429).send("잠시 후 다시 시도해주세요.") }
    if (req.path === "/oauth/register" && req.method === "POST" && !store.hit("registration", 60, 3600)) {
      res.setHeader("Retry-After", "3600"); return res.status(429).json({ error: "temporarily_unavailable" })
    }
    next()
  })
  app.get(METADATA_PATHS, (_req, res) => res.json({ resource, authorization_servers: [issuer], scopes_supported: [LAW_SCOPE], bearer_methods_supported: ["header"] }))

  app.get("/oauth/interaction/:uid", async (req, res) => {
    const details = await provider.interactionDetails(req, res)
    const fields = `<input type="hidden" name="csrf" value="${csrf(details.uid)}">`
    if (details.prompt.name === "login") {
      res.send(html(`<h1>법령 MCP 로그인</h1><p>관리자가 발급한 직원 계정으로 로그인해주세요.</p><p><small>같은 계정의 기존 연결은 새 로그인이 성공하면 종료됩니다.</small></p><form method="post" action="/oauth/interaction/${escape(details.uid)}">${fields}<label for="username">아이디</label><input id="username" name="username" autocomplete="username" maxlength="64" required><label for="password">비밀번호</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required><button name="action" value="login">로그인</button></form>`))
    } else if (details.prompt.name === "consent" && details.session && employees.has(details.session.accountId)) {
      const client = await provider.Client.find(String(details.params.client_id))
      res.send(html(`<h1>법령 조회 연결 허용</h1><p><strong>${escape(client?.clientName || "MCP 클라이언트")}</strong>가 <strong>${escape(details.session.accountId)}</strong> 계정으로 법령·판례 조회 도구를 사용하도록 허용합니다.</p><p><small>서버의 법제처 인증값과 직원 비밀번호는 ChatGPT에 전달되지 않습니다.</small></p><form method="post" action="/oauth/interaction/${escape(details.uid)}">${fields}<button name="action" value="consent">허용</button><button name="action" value="deny">취소</button></form>`))
    } else { res.status(400).send(html("<h1>연결을 다시 시작해주세요</h1>")) }
  })
  app.post("/oauth/interaction/:uid", formParser, async (req, res) => {
    const details = await provider.interactionDetails(req, res)
    const expected = csrf(details.uid)
    const submitted = req.body?.csrf
    if (req.get("origin") !== issuer || typeof submitted !== "string" || !/^[a-f0-9]{64}$/.test(submitted)
      || !timingSafeEqual(Buffer.from(submitted), Buffer.from(expected))) return res.status(403).send("Invalid interaction.")
    if (req.body.action === "deny") return provider.interactionFinished(req, res, { error: "access_denied", error_description: "User declined access." }, { mergeWithLastSubmission: false })
    if (details.prompt.name === "login" && req.body.action === "login") {
      const id = typeof req.body.username === "string" ? req.body.username : ""
      const bucket = createHash("sha256").update(id.slice(0, 64)).digest("hex")
      if (!store.hit(`login:${bucket}`, 10, 300) || !store.hit("login-global", 100, 60)) { res.setHeader("Retry-After", "300"); return res.status(429).send("잠시 후 다시 시도해주세요.") }
      const employee = employees.get(id)
      const valid = await verifyPassword(req.body.password, employee?.passwordHash || dummyHash)
      if (!employee || !valid || store.isBlocked(id)) return res.status(401).send(html(`<h1>로그인 정보를 확인해주세요</h1><p class="error">아이디·비밀번호 또는 계정 사용 권한을 확인해주세요.</p><a href="/oauth/interaction/${escape(details.uid)}">다시 로그인</a>`))
      const connectionId = store.beginLogin(employee.id, details.uid)
      return provider.interactionFinished(req, res, { login: { accountId: employee.id, amr: ["pwd"], remember: false, connectionId } }, { mergeWithLastSubmission: false })
    }
    if (details.prompt.name === "consent" && req.body.action === "consent" && details.session && employees.has(details.session.accountId)) {
      const connectionId = details.lastSubmission?.login?.connectionId
      if (!store.isCurrentLogin(details.session.accountId, connectionId)) return res.status(409).send(html("<h1>다른 곳에서 새로 로그인했습니다</h1><p>이 연결은 종료되었습니다. ChatGPT에서 다시 연결해주세요.</p>"))
      const grant = details.grantId ? await provider.Grant.find(details.grantId) : new provider.Grant({ accountId: details.session.accountId, clientId: String(details.params.client_id) })
      if (!grant) return res.status(400).send("Invalid grant.")
      const prompt = details.prompt.details
      if (prompt.missingOIDCScope) grant.addOIDCScope((prompt.missingOIDCScope as string[]).join(" "))
      if (prompt.missingOIDCClaims) grant.addOIDCClaims(prompt.missingOIDCClaims as string[])
      const resources = prompt.missingResourceScopes as Record<string, string[]> | undefined
      for (const [aud, scopes] of Object.entries(resources || {})) {
        if (aud !== resource || scopes.some(scope => scope !== LAW_SCOPE)) return res.status(400).send("Invalid scope.")
        grant.addResourceScope(aud, scopes.join(" "))
      }
      grant.jti ||= randomBytes(32).toString("base64url")
      store.activateGrant(details.session.accountId, connectionId, grant.jti)
      const grantId = await grant.save()
      return provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true })
    }
    res.status(400).send("Invalid interaction.")
  })
  app.use((req, res, next) => {
    if (req.path.startsWith("/oauth/") || DISCOVERY_PATHS.has(req.path)) {
      // All discovery documents are served publicly, before the legacy token gate.
      if (req.path === "/.well-known/oauth-authorization-server") req.url = "/.well-known/openid-configuration"
      return callback(req, res)
    }
    next()
  })
  app.use((error: unknown, req: Request, res: Response, next: express.NextFunction) => {
    if (!req.path.startsWith("/oauth/") && !DISCOVERY_PATHS.has(req.path)) return next(error)
    if (res.headersSent) return next(error)
    // Invalid/expired interaction cookies must not send protocol parameters to logs or the browser.
    res.status(400).send(html("<h1>연결을 다시 시작해주세요</h1><p>로그인 요청이 만료되었거나 올바르지 않습니다. ChatGPT에서 다시 연결해주세요.</p>"))
  })
  const cleanup = setInterval(() => store.cleanup(), 60000).unref()
  const authenticatedAccounts = new WeakMap<Request, string>()
  return {
    provider, resource,
    recordToolCalls(req: Request, count: number) {
      const accountId = authenticatedAccounts.get(req)
      if (accountId) store.recordToolCalls(accountId, count)
    },
    challenge(res: Response, insufficientScope = false) {
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource", scope="${LAW_SCOPE}"${insufficientScope ? ', error="insufficient_scope"' : ""}`)
      res.setHeader("Cache-Control", "no-store")
    },
    async authenticate(req: Request): Promise<"valid" | "invalid" | "scope"> {
      const match = /^Bearer ([A-Za-z0-9._~-]{1,4096})$/i.exec(req.get("authorization") || "")
      if (!match) return "invalid"
      try {
        // Opaque tokens are looked up only in this issuer's persistent store, then checked against the resource and live grant.
        const token = await provider.AccessToken.find(match[1])
        if (!token || token.isExpired || token.aud !== resource || !token.accountId || !employees.has(token.accountId)
          || !token.grantId || !await provider.Grant.find(token.grantId)) return "invalid"
        if (!token.scopes.has(LAW_SCOPE)) return "scope"
        authenticatedAccounts.set(req, token.accountId)
        if (req.path === "/mcp") store.recordRequest(token.accountId)
        return "valid"
      } catch { return "invalid" }
    },
    close() { clearInterval(cleanup); store.close() },
  }
  } catch (error) { store.close(); throw error }
}
