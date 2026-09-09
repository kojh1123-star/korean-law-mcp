import express, { type Express, type Request, type Response } from "express"
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { Employee } from "./oauth-accounts.js"
import { verifyPassword } from "./oauth-accounts.js"
import type { OAuthStore } from "./oauth-store.js"

const esc = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))
const digest = (v: string) => createHash("sha256").update(v).digest("hex")
const equal = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.length === b.length
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const stamp = (v: unknown) => v == null ? "기록 없음" : new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "medium",
}).format(new Date(Number(v) * 1000))
const actionNames = { disconnect: "연결 강제 종료", block: "사용 차단", unblock: "차단 해제" }
function page(body: string) {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>법령 MCP 관리</title>
  <style>body{margin:0;background:#f3f5f8;color:#182337;font:15px/1.6 system-ui,sans-serif}main{max-width:1120px;margin:40px auto;padding:28px;background:white;border:1px solid #dbe2ec;border-radius:16px}h1{margin:0;font-size:28px}h2{font-size:20px;margin-top:28px}p{color:#526176}a{color:#164eb5}label{display:block;margin:16px 0 5px}input{padding:11px;border:1px solid #aab5c5;border-radius:7px;font:inherit;max-width:95%}button,.button{display:inline-block;border:0;border-radius:7px;padding:10px 14px;background:#164eb5;color:white;font:inherit;text-decoration:none;cursor:pointer}button.danger{background:#b52d36}button.secondary{background:#e9eef6;color:#213958}.actions{display:flex;gap:8px;flex-wrap:wrap}.top{display:flex;justify-content:space-between;align-items:center;gap:16px}.cards{display:flex;gap:14px;flex-wrap:wrap;margin:24px 0}.card{padding:16px 22px;background:#f3f6fb;border-radius:10px;min-width:150px}.card strong{display:block;font-size:30px;color:#164eb5}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;white-space:nowrap}th,td{text-align:left;padding:13px 12px;border-bottom:1px solid #e4e8ee}th{background:#f5f7fa}.status{font-weight:600}.blocked{color:#ad2636}.connected{color:#08745a}.notice{padding:12px 16px;background:#e9f6ef;color:#215e3b;border-radius:8px}.login{max-width:420px}.error{color:#ac2835}small{color:#65738a}@media(max-width:700px){main{margin:12px;padding:20px}.top{align-items:flex-start;flex-direction:column}}</style><main>${body}</main></html>`
}

export function installAdmin(app: Express, options: {
  issuer: string; local: boolean; employees: Map<string, Employee>; store: OAuthStore;
  secret: string; dummyHash: string; adminIds: Set<string>;
}) {
  const { issuer, local, employees, store, secret, dummyHash, adminIds } = options
  const router = express.Router()
  const sessions = new (store.adapter())("AdminSession")
  const cookieName = local ? "law_admin" : "__Secure-law_admin"
  const preName = local ? "law_admin_pre" : "__Secure-law_admin_pre"
  const cookieOptions = { httpOnly: true, secure: !local, sameSite: "strict" as const, path: "/admin" }
  const cookie = (req: Request, name: string) => {
    const values = (req.get("cookie") || "").split(";").map(v => v.trim()).filter(v => v.startsWith(name + "="))
    if (values.length !== 1) return ""
    return values[0].slice(name.length + 1)
  }
  const sign = (s: string) => createHmac("sha256", secret).update("admin-login:" + s).digest("hex")
  const loginForm = (res: Response, error = false) => {
    const data = `${Math.floor(Date.now() / 1000)}.${randomBytes(24).toString("hex")}`
    const csrf = `${data}.${sign(data)}`
    res.cookie(preName, csrf, { ...cookieOptions, maxAge: 600000 })
    return res.status(error ? 401 : 200).send(page(`<div class="login"><h1>법령 MCP 관리자 로그인</h1><p>관리자 권한을 받은 직원 계정으로 로그인하세요.</p>${error ? '<p class="error">아이디·비밀번호 또는 관리자 권한을 확인해주세요.</p>' : ""}<form method="post" action="/admin/login"><input type="hidden" name="csrf" value="${csrf}"><label for="username">아이디</label><input id="username" name="username" autocomplete="username" maxlength="64" required><label for="password">비밀번호</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required><p><button>관리자 로그인</button></p></form></div>`))
  }
  router.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "same-origin", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" })
    if (!local && (req.get("host") !== new URL(issuer).host || req.protocol !== "https")) return res.status(400).send("Invalid origin.")
    if (!adminIds.size) return res.status(503).send(page("<h1>관리자 설정이 필요합니다</h1><p>Railway에서 OAUTH_ADMIN_IDS를 지정해주세요.</p>"))
    if (!store.hit(`admin-requests:${digest(req.ip || "unknown")}`, 120, 60)) return res.status(429).send("잠시 후 다시 시도해주세요.")
    next()
  })
  router.use(express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 6 }))
  router.get("/login", (_req, res) => loginForm(res))
  router.post("/login", async (req, res) => {
    const pre = cookie(req, preName)
    const parts = pre.split(".")
    const now = Math.floor(Date.now() / 1000)
    if (req.get("origin") !== issuer || parts.length !== 3 || !/^\d{10}\.[a-f0-9]{48}\.[a-f0-9]{64}$/.test(pre)
      || Number(parts[0]) > now || now - Number(parts[0]) > 600 || !equal(parts[2], sign(parts.slice(0, 2).join("."))) || !equal(req.body?.csrf, pre)) {
      return res.status(403).send(page("<h1>로그인을 다시 시작해주세요</h1><p><a href='/admin/login'>관리자 로그인</a></p>"))
    }
    const id = typeof req.body.username === "string" ? req.body.username : ""
    if (!store.hit(`admin-login:${digest(id.slice(0, 64))}`, 10, 300) || !store.hit("admin-login-global", 100, 60)) return res.status(429).send("잠시 후 다시 시도해주세요.")
    const employee = employees.get(id)
    const valid = await verifyPassword(req.body.password, employee?.passwordHash || dummyHash)
    if (!valid || !employee || !adminIds.has(id) || store.isBlocked(id)) return loginForm(res, true)
    const sessionToken = randomBytes(32).toString("hex")
    store.revokeAdminSessions(id)
    await sessions.upsert(digest(sessionToken), { accountId: id, passwordVersion: digest(employee.passwordHash), csrf: randomBytes(32).toString("hex") }, 28800)
    res.clearCookie(preName, cookieOptions)
    res.cookie(cookieName, sessionToken, { ...cookieOptions, maxAge: 28800000 })
    res.redirect(303, "/admin")
  })
  router.use(async (req, res, next) => {
    const token = cookie(req, cookieName)
    const session = /^[a-f0-9]{64}$/.test(token) ? await sessions.find(digest(token)) : undefined
    const id = session?.accountId
    const employee = typeof id === "string" ? employees.get(id) : undefined
    if (!session || !employee || !adminIds.has(employee.id) || store.isBlocked(employee.id) || session.passwordVersion !== digest(employee.passwordHash)) {
      if (req.method === "GET") return res.redirect(303, "/admin/login")
      return res.status(401).send("관리자 로그인이 필요합니다.")
    }
    res.locals.admin = { id: employee.id, key: digest(token), csrf: session.csrf }
    if (req.method !== "GET" && (req.get("origin") !== issuer || !equal(req.body?.csrf, session.csrf))) return res.status(403).send("요청을 확인할 수 없습니다. 관리자 화면을 다시 열어주세요.")
    next()
  })
  router.get("/", (_req, res) => {
    const admin = res.locals.admin
    const rows = [...employees.keys()].map(id => store.connectionSummary(id))
    const recent = rows.filter(r => !r.blocked && r.lastRequest !== null && r.lastRequest > Date.now() / 1000 - 300).length
    const csrf = `<input type="hidden" name="csrf" value="${esc(admin.csrf)}">`
    const controls = (id: string, blocked: boolean) => `<form method="post" action="/admin/accounts">${csrf}<input type="hidden" name="target" value="${esc(id)}"><div class="actions"><button class="secondary" name="action" value="disconnect">연결 강제 종료</button>${adminIds.has(id) ? "<small>관리자 계정</small>" : `<button class="${blocked ? "" : "danger"}" name="action" value="${blocked ? "unblock" : "block"}">${blocked ? "차단 해제" : "사용 차단"}</button>`}</div></form>`
    const logs = store.auditLog().map(r => `<tr><td>${stamp(r.at)}</td><td>${esc(r.actor)}</td><td>${esc(r.target)}</td><td>${esc(actionNames[r.action as keyof typeof actionNames] || r.action)}</td></tr>`).join("")
    res.send(page(`<div class="top"><div><h1>법령 MCP 계정 관리</h1><p>${esc(admin.id)} 관리자 · ${stamp(Math.floor(Date.now() / 1000))} 기준</p></div><div class="actions"><a class="button" href="/admin">새로고침</a><form method="post" action="/admin/logout">${csrf}<button class="secondary">관리자 로그아웃</button></form></div></div>
      <div class="cards"><div class="card">등록 계정<strong>${rows.length}</strong></div><div class="card">연결 유효<strong>${rows.filter(r => r.connected).length}</strong></div><div class="card">최근 5분 요청 계정<strong>${recent}</strong></div><div class="card">차단 계정<strong>${rows.filter(r => r.blocked).length}</strong></div></div>
      <p>연결 강제 종료: 현재 연결을 끊습니다. 직원은 다시 로그인할 수 있습니다.<br>사용 차단: 현재 연결을 끊고, 차단 해제 전까지 재로그인도 막습니다.</p><div class="scroll"><table><thead><tr><th>계정</th><th>상태</th><th>마지막 로그인</th><th>마지막 MCP 요청</th><th>관리</th></tr></thead><tbody>${rows.map(r => `<tr><td><strong>${esc(r.id)}</strong></td><td class="status ${r.blocked ? "blocked" : r.connected ? "connected" : ""}">${r.blocked ? "사용 차단" : r.connected ? "연결 유효" : "연결 없음"}</td><td>${stamp(r.lastLogin)}</td><td>${stamp(r.lastRequest)}</td><td>${controls(r.id, r.blocked)}</td></tr>`).join("")}</tbody></table></div>
      <p><small>‘연결 유효’는 유효한 조회·갱신 인증정보가 있는 계정 수입니다. 실제로 화면을 보고 있는 인원수와 다릅니다. 최근 요청에는 도구 목록 확인 등도 포함되며, 기록은 이 기능 적용 이후부터 집계합니다. 이미 처리 중인 요청은 계속될 수 있습니다.</small></p>
      <h2>최근 관리 기록</h2><p>최대 90일 보관 · 최근 30건 표시</p><div class="scroll"><table><thead><tr><th>시각 (한국)</th><th>관리자</th><th>대상 계정</th><th>작업</th></tr></thead><tbody>${logs || '<tr><td colspan="4">아직 관리 기록이 없습니다.</td></tr>'}</tbody></table></div>`))
  })
  router.post("/accounts", (req, res) => {
    const { target, action } = req.body || {}
    if (typeof target !== "string" || !employees.has(target)) return res.status(404).send("등록된 계정이 아닙니다.")
    if (!["disconnect", "block", "unblock"].includes(action)) return res.status(400).send("지원하지 않는 작업입니다.")
    if (adminIds.has(target) && action !== "disconnect") return res.status(403).send("관리자 계정은 이 화면에서 차단할 수 없습니다.")
    store.manageAccount(res.locals.admin.id, target, action)
    res.redirect(303, "/admin")
  })
  router.post("/logout", async (_req, res) => {
    await sessions.destroy(res.locals.admin.key)
    res.clearCookie(cookieName, cookieOptions)
    res.redirect(303, "/admin/login")
  })
  router.use((_error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    if (!res.headersSent) res.status(400).send(page("<h1>요청을 완료하지 못했습니다</h1><p><a href='/admin'>관리자 화면으로 돌아가기</a></p>"))
  })
  app.use("/admin", router)
}
