import express, { type Express, type Request, type Response } from "express"
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { Employee } from "./oauth-accounts.js"
import { hashPassword, verifyPassword } from "./oauth-accounts.js"
import type { OAuthStore } from "./oauth-store.js"
import multer from "multer"
import { ADMIN_LIVE_SCRIPT } from "./admin-live.js"
import { trafficHtml } from "./admin-traffic.js"
import { SERVICES, SERVICE_IDS, type ServiceId } from "./services.js"
import type { AccountBackups } from "./oauth-backups.js"

const esc = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))
const digest = (v: string) => createHash("sha256").update(v).digest("hex")
const equal = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.length === b.length
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const stamp = (v: unknown) => v == null ? "기록 없음" : new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "medium",
}).format(new Date(Number(v) * 1000))
const actionNames = { disconnect: "연결 강제 종료", block: "사용 차단", unblock: "차단 해제", create: "계정 추가", remove: "계정 제거", credentials: "관리자 로그인 정보 변경", password_reset: "직원 비밀번호 초기화", recovery_issue: "복구 코드 발급", recovery_used: "복구 코드 사용", backup: "백업 다운로드", restore: "계정 데이터 복원", services: "서비스 권한 변경" }
function page(body: string, nonce?: string) {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>통합 MCP 관리</title>
  <style>body{margin:0;background:#f3f5f8;color:#182337;font:15px/1.6 system-ui,sans-serif}main{max-width:1120px;margin:40px auto;padding:28px;background:white;border:1px solid #dbe2ec;border-radius:16px}h1{margin:0;font-size:28px}h2{font-size:20px;margin-top:28px}p{color:#526176}a{color:#164eb5}label{display:block;margin:16px 0 5px}input{padding:11px;border:1px solid #aab5c5;border-radius:7px;font:inherit;max-width:95%}button,.button{display:inline-block;border:0;border-radius:7px;padding:10px 14px;background:#164eb5;color:white;font:inherit;text-decoration:none;cursor:pointer}button.danger{background:#b52d36}button.secondary{background:#e9eef6;color:#213958}.actions{display:flex;gap:8px;flex-wrap:wrap}.top{display:flex;justify-content:space-between;align-items:center;gap:16px}.cards{display:flex;gap:14px;flex-wrap:wrap;margin:24px 0}.card{padding:16px 22px;background:#f3f6fb;border-radius:10px;min-width:150px}.card strong{display:block;font-size:30px;color:#164eb5}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;white-space:nowrap}th,td{text-align:left;padding:13px 12px;border-bottom:1px solid #e4e8ee}th{background:#f5f7fa}.status{font-weight:600}.blocked{color:#ad2636}.connected{color:#08745a}.notice{padding:12px 16px;background:#e9f6ef;color:#215e3b;border-radius:8px}.login{max-width:420px}.error{color:#ac2835}small{color:#65738a}@media(max-width:700px){main{margin:12px;padding:20px}.top{align-items:flex-start;flex-direction:column}}</style><main>${body}</main>${nonce ? `<script nonce="${nonce}">${ADMIN_LIVE_SCRIPT}</script>` : ""}</html>`
}

export function installAdmin(app: Express, options: {
  issuer: string; local: boolean; employees: Map<string, Employee>; store: OAuthStore;
  secret: string; dummyHash: string; adminIds: Set<string>;
  backups?: AccountBackups; bootstrapEmployees?: Map<string, Employee>; adminRoots?: string[];
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
  const preToken = (res: Response) => {
    const data = `${Math.floor(Date.now() / 1000)}.${randomBytes(24).toString("hex")}`
    const csrf = `${data}.${sign(data)}`
    res.cookie(preName, csrf, { ...cookieOptions, maxAge: 600000 })
    return csrf
  }
  const validPre = (req: Request) => {
    const pre = cookie(req, preName), parts = pre.split("."), now = Math.floor(Date.now() / 1000)
    return req.get("origin") === issuer && /^\d{10}\.[a-f0-9]{48}\.[a-f0-9]{64}$/.test(pre)
      && Number(parts[0]) <= now && now - Number(parts[0]) <= 600 && equal(parts[2], sign(parts.slice(0, 2).join("."))) && equal(req.body?.csrf, pre)
  }
  const loginForm = (res: Response, error = false) => {
    const csrf = preToken(res)
    return res.status(error ? 401 : 200).send(page(`<div class="login"><h1>통합 MCP 관리자 로그인</h1><p>관리자 권한을 받은 직원 계정으로 로그인하세요.</p>${error ? '<p class="error">아이디·비밀번호 또는 관리자 권한을 확인해주세요.</p>' : ""}<form method="post" action="/admin/login"><input type="hidden" name="csrf" value="${csrf}"><label for="username">아이디</label><input id="username" name="username" autocomplete="username" maxlength="64" required><label for="password">비밀번호</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required><p><button>관리자 로그인</button></p></form><a href="/admin/recover">복구 코드로 비밀번호 찾기</a></div>`))
  }
  router.use((req, res, next) => {
    const nonce = randomBytes(24).toString("base64url")
    res.locals.scriptNonce = nonce
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "same-origin", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` })
    if (!local && (req.get("host") !== new URL(issuer).host || req.protocol !== "https")) return res.status(400).send("Invalid origin.")
    if (!adminIds.size) return res.status(503).send(page("<h1>관리자 설정이 필요합니다</h1><p>Railway에서 OAUTH_ADMIN_IDS를 지정해주세요.</p>"))
    if (!store.hit(`admin-requests:${digest(req.ip || "unknown")}`, 120, 60)) return res.status(429).send("잠시 후 다시 시도해주세요.")
    next()
  })
  router.use(express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 6 }))
  router.get("/login", (_req, res) => loginForm(res))
  router.get("/recover", (_req, res) => res.send(page(`<h1>관리자 비밀번호 복구</h1><p>미리 보관한 일회용 복구 코드가 필요합니다. 사용한 코드는 다시 사용할 수 없습니다.</p><form method="post" action="/admin/recover"><input type="hidden" name="csrf" value="${preToken(res)}"><label for="recovery-id">관리자 아이디</label><input id="recovery-id" name="username" maxlength="64" autocomplete="username" required><label for="recovery-code">복구 코드</label><input id="recovery-code" name="code" type="password" maxlength="64" autocomplete="off" required><label for="recovery-password">새 비밀번호</label><input id="recovery-password" name="password" type="password" minlength="12" maxlength="256" autocomplete="new-password" required><label for="recovery-repeat">새 비밀번호 확인</label><input id="recovery-repeat" name="repeat" type="password" minlength="12" maxlength="256" autocomplete="new-password" required><p><button>비밀번호 복구</button></p></form><a href="/admin/login">로그인으로 돌아가기</a>`)))
  router.post("/recover", async (req, res) => {
    if (!validPre(req)) return res.status(403).send("복구 화면을 다시 열어주세요.")
    const { username: id, code, password, repeat } = req.body || {}
    const employee = typeof id === "string" ? employees.get(id) : undefined
    if (!store.hit(`recovery:${digest(String(id).slice(0, 64))}`, 5, 300) || !store.hit("recovery-global", 30, 300)) return res.status(429).send("잠시 후 다시 시도해주세요.")
    if (!employee || !adminIds.has(employee.id) || store.isBlocked(employee.id) || typeof code !== "string" || !store.recoveryMatches(employee.id, code)) return res.status(401).send("아이디와 복구 코드를 확인해주세요.")
    if (typeof password !== "string" || password !== repeat || password.length < 12 || Buffer.byteLength(password) > 256) return res.status(400).send("비밀번호를 12자 이상, UTF-8 256바이트 이하로 두 번 동일하게 입력해주세요.")
    const next = { id: employee.id, passwordHash: await hashPassword(password) }
    if (employees.get(employee.id) !== employee || !adminIds.has(employee.id) || store.isBlocked(employee.id)) return res.status(401).send("로그인 정보가 변경되었습니다.")
    store.changeAdminAccount(employee, next, { recoveryHash: digest(code), action: "recovery_used" })
    employees.set(next.id, next)
    res.clearCookie(cookieName, cookieOptions)
    res.clearCookie(preName, cookieOptions)
    res.send(page('<h1>비밀번호 복구 완료</h1><p>기존 로그인과 복구 코드는 종료되었습니다. 새 비밀번호로 로그인하고 복구 코드를 다시 발급하세요.</p><a href="/admin/login">관리자 로그인</a>'))
  })
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
    if (!valid || !employee || employees.get(id) !== employee || !adminIds.has(id) || store.isBlocked(id)) return loginForm(res, true)
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
    if (req.method !== "GET" && (req.get("origin") !== issuer || (req.path !== "/restore" && !equal(req.body?.csrf, session.csrf)))) return res.status(403).send("요청을 확인할 수 없습니다. 관리자 화면을 다시 열어주세요.")
    next()
  })
  router.get("/", (req, res) => {
    const admin = res.locals.admin
    const period = req.query.period === "today" || req.query.period === "month" ? req.query.period : "all"
    const service: ServiceId | "all" = SERVICE_IDS.includes(req.query.service as ServiceId) ? req.query.service as ServiceId : "all"
    const usage = store.usageSummary(period, [...employees.keys()], Date.now(), service)
    const periodNames = { today: "오늘", month: "이번 달", all: "누적 전체" }
    const serviceNav = `<nav class="actions" aria-label="사용량 서비스">${["all", ...SERVICE_IDS].map(id => `<a class="button" href="/admin?period=${period}&service=${id}"${service === id ? ' aria-current="page"' : ""}>${id === "all" ? "전체 서비스" : SERVICES[id as ServiceId].name}</a>`).join("")}</nav>`
    const usageHtml = `<h2>직원별 사용량 · ${periodNames[period]} · ${service === "all" ? "전체 서비스" : SERVICES[service].name}</h2>${serviceNav}<nav class="actions" aria-label="사용량 기간">${Object.entries(periodNames).map(([key, label]) => `<a class="button" href="/admin?period=${key}&service=${service}"${period === key ? ' aria-current="page"' : ''}>${label}</a>`).join("")}</nav>
      <p>직원 전체 <strong>${usage.total.toLocaleString("ko-KR")}회</strong> · 한국시간 기준 · 집계 시작 ${stamp(usage.startedAt)}</p>
      <div class="scroll"><table aria-label="직원별 사용량"><thead><tr><th>계정</th><th>도구 호출 횟수</th><th>전체 대비 비율</th></tr></thead><tbody>${usage.rows.map(r => `<tr><td>${esc(r.id)}${r.registered ? "" : " (등록 해제)"}</td><td>${r.calls.toLocaleString("ko-KR")}회</td><td>${r.percent.toFixed(1)}% <meter min="0" max="100" value="${r.percent}" aria-label="${esc(r.id)} 사용 비율">${r.percent.toFixed(1)}%</meter></td></tr>`).join("")}</tbody></table></div>
      <p><small>비율 = 계정 호출 횟수 ÷ 같은 기간·선택한 서비스의 직원 전체 호출 횟수 × 100. 총 0회일 때는 0.0%로 표시하며 반올림으로 비율 합계가 100%와 다를 수 있습니다.<br>직원 로그인으로 접수되어 인증·사용 제한을 통과한 도구 호출 요청을 집계합니다. 처리 중 오류·재시도도 포함합니다. 로그인·도구 목록 확인·관리 화면·공용 토큰 요청은 제외합니다. 외부 API 호출 횟수나 ChatGPT 토큰·요금과는 다릅니다. 등록 해제된 계정의 기존 사용량도 전체에 포함됩니다. 적용 이전 기록은 없습니다.</small></p>`
    const rows = [...employees.keys()].map(id => store.connectionSummary(id))
    const recent = rows.filter(r => !r.blocked && r.lastRequest !== null && r.lastRequest > Date.now() / 1000 - 300).length
    const csrf = `<input type="hidden" name="csrf" value="${esc(admin.csrf)}">`
    const notice = req.query.notice === "created" ? "직원 계정을 추가했습니다. 지금부터 직원이 로그인할 수 있습니다." : req.query.notice === "removed" ? "직원 계정을 제거하고 기존 연결을 종료했습니다." : ""
    const addForm = `<h2>직원 계정 추가</h2><details><summary>새 직원 등록하기</summary><p>일반 직원 계정을 추가합니다. 아이디는 영문·숫자·점·밑줄·하이픈 3~64자, 비밀번호는 12자 이상입니다. 아이디는 대소문자를 구분합니다. 제거한 아이디는 재사용할 수 없습니다.</p>
      <form method="post" action="/admin/employees">${csrf}<label for="new-id">새 직원 아이디</label><input id="new-id" name="username" minlength="3" maxlength="64" pattern="[a-zA-Z0-9._\\-]{3,64}" autocomplete="off" required>
      <label for="new-password">새 직원 비밀번호</label><input id="new-password" name="password" type="password" minlength="12" maxlength="256" autocomplete="new-password" required>
      <label for="new-password-repeat">비밀번호 확인</label><input id="new-password-repeat" name="repeat" type="password" minlength="12" maxlength="256" autocomplete="new-password" required><p><button>계정 추가</button></p></form></details>`
    const controls = (id: string, blocked: boolean) => `<form method="post" action="/admin/accounts">${csrf}<input type="hidden" name="target" value="${esc(id)}"><div class="actions"><button class="secondary" name="action" value="disconnect">연결 강제 종료</button><a class="button secondary" href="/admin/access?target=${encodeURIComponent(id)}">서비스 권한</a>${adminIds.has(id) ? "<small>관리자 계정</small>" : `<button class="${blocked ? "" : "danger"}" name="action" value="${blocked ? "unblock" : "block"}">${blocked ? "차단 해제" : "사용 차단"}</button><a class="button secondary" href="/admin/reset?target=${encodeURIComponent(id)}">비밀번호 초기화</a><a class="button secondary" href="/admin/remove?target=${encodeURIComponent(id)}">계정 제거</a>`}</div></form>`
    const serviceCards = '<h2>연결 주소와 기존 처리 집계</h2><p><small>키 설정 여부는 실제 인증 성공과 다릅니다. HTTP 처리 오류는 인증 후 MCP 요청의 HTTP 오류이며, 정상 응답에 포함된 외부 API 오류는 별도로 도구 응답을 확인하세요. 서버 재시작 후에도 집계를 유지합니다.</small></p><div class="cards">' + SERVICE_IDS.map(id => { const m = store.serviceMetrics(id); const configured = !!process.env[id === "law" ? "LAW_OC" : id === "g2b" ? "G2B_API_KEY" : "KOSIS_TOKEN"]; return `<div class="card"><h3>${SERVICES[id].name}</h3><p>인증키: ${configured ? "설정됨" : "미설정"}</p><p>인증 후 MCP POST ${m.requests}회 · HTTP 오류 ${m.errors}회<br>최근 정상 HTTP 응답: ${stamp(m.last_success)}<br>최근 HTTP 오류: ${stamp(m.last_error)}</p><p>연결 주소<br><code style="overflow-wrap:anywhere">${esc(issuer + SERVICES[id].path)}</code></p></div>` }).join("") + '</div>'
    const logs = store.auditLog().map(r => `<tr><td>${stamp(r.at)}</td><td>${esc(r.actor)}</td><td>${esc(r.target)}</td><td>${esc(actionNames[r.action as keyof typeof actionNames] || r.action)}</td></tr>`).join("")
    res.send(page(`<div class="top"><div><h1>통합 MCP 계정 관리</h1><p id="live-updated" data-live>${esc(admin.id)} 관리자 · ${stamp(Math.floor(Date.now() / 1000))} 기준</p></div><div class="actions"><a class="button secondary" href="/admin/security">복구·백업 관리</a><a class="button secondary" href="/admin/profile">내 로그인 정보 변경</a><a class="button" href="/admin?period=${period}&service=${service}">새로고침</a><form method="post" action="/admin/logout">${csrf}<button class="secondary">관리자 로그아웃</button></form></div></div>
      <p><span id="live-status" role="status">5초마다 자동 갱신 · 화면을 열어두면 최신 값을 받습니다.</span> <button type="button" id="live-toggle" class="secondary">자동 갱신 끄기</button></p>
      ${notice ? `<p class="notice" role="status">${notice}</p>` : ""}
      <div id="live-summary" data-live class="cards"><div class="card">등록 계정<strong>${rows.length}</strong></div><div class="card">연결 유효<strong>${rows.filter(r => r.connected).length}</strong></div><div class="card">최근 5분 요청 계정<strong>${recent}</strong></div><div class="card">차단 계정<strong>${rows.filter(r => r.blocked).length}</strong></div></div>
      <p>연결 강제 종료: 현재 연결을 끊습니다. 직원은 다시 로그인할 수 있습니다.<br>사용 차단: 현재 연결을 끊고, 차단 해제 전까지 재로그인도 막습니다.</p><div class="scroll"><table><thead><tr><th>계정</th><th>상태</th><th>서비스 연결</th><th>마지막 로그인</th><th>마지막 MCP 요청</th><th>관리</th></tr></thead><tbody id="live-accounts" data-live>${rows.map(r => `<tr><td><strong>${esc(r.id)}</strong></td><td class="status ${r.blocked ? "blocked" : r.connected ? "connected" : ""}">${r.blocked ? "사용 차단" : r.connected ? "연결 유효" : "연결 없음"}</td><td>${SERVICE_IDS.filter(id => store.connectionSummary(r.id, id).connected).map(id => SERVICES[id].name).join(" · ") || "없음"}</td><td>${stamp(r.lastLogin)}</td><td>${stamp(r.lastRequest)}</td><td>${controls(r.id, r.blocked)}</td></tr>`).join("")}</tbody></table></div>
      <p><small>‘연결 유효’는 유효한 조회·갱신 인증정보가 있는 계정 수입니다. 실제로 화면을 보고 있는 인원수와 다릅니다. 최근 요청에는 도구 목록 확인 등도 포함되며, 기록은 이 기능 적용 이후부터 집계합니다. 이미 처리 중인 요청은 계속될 수 있습니다.</small></p>
      ${addForm}
      <section id="live-usage" data-live>${usageHtml}</section>
      <section id="live-traffic" data-live>${trafficHtml(store, period)}</section>
      <section id="live-services" data-live>${serviceCards}</section>
      <h2>최근 관리 기록</h2><p>최대 90일 보관 · 최근 30건 표시</p><div class="scroll"><table><thead><tr><th>시각 (한국)</th><th>관리자</th><th>대상 계정</th><th>작업</th></tr></thead><tbody id="live-audit" data-live>${logs || '<tr><td colspan="4">아직 관리 기록이 없습니다.</td></tr>'}</tbody></table></div>`, res.locals.scriptNonce))
  })
  const accountError = (res: Response, status: number, message: string) => res.status(status).send(page(`<h1>계정 관리</h1><p class="error">${esc(message)}</p><a href="/admin">관리자 화면으로 돌아가기</a>`))
  const reauthenticate = async (req: Request, res: Response) => {
    const employee = employees.get(res.locals.admin.id)
    if (!employee || !store.hit(`sensitive:${digest(employee.id)}`, 10, 300)) return false
    const valid = await verifyPassword(req.body?.currentPassword, employee.passwordHash)
    return valid && employees.get(employee.id) === employee && !!await sessions.find(res.locals.admin.key)
  }
  router.get("/access", (req, res) => {
    const target = typeof req.query.target === "string" ? req.query.target : ""
    if (!employees.has(target)) return accountError(res, 404, "계정을 찾을 수 없습니다.")
    res.send(page(`<h1>서비스 권한 설정</h1><p>${esc(target)} 계정의 서비스를 선택하세요. 해제한 서비스의 기존 연결은 종료됩니다. 계정 전체가 차단된 경우 서비스 권한과 관계없이 이용할 수 없습니다.</p><form method="post" action="/admin/access"><input type="hidden" name="csrf" value="${esc(res.locals.admin.csrf)}"><input type="hidden" name="target" value="${esc(target)}">${SERVICE_IDS.map(id => `<label><input type="checkbox" name="services" value="${id}"${store.serviceAllowed(target, id) ? " checked" : ""}> ${SERVICES[id].name}</label>`).join("")}<p><button>권한 저장</button></p></form><a href="/admin">관리자 화면</a>`))
  })
  router.post("/access", (req, res) => {
    const target = typeof req.body.target === "string" ? req.body.target : ""
    if (!employees.has(target)) return accountError(res, 404, "계정을 찾을 수 없습니다.")
    const values = req.body.services === undefined ? [] : Array.isArray(req.body.services) ? req.body.services : [req.body.services]
    if (values.some((v: unknown) => !SERVICE_IDS.includes(v as ServiceId))) return accountError(res, 400, "서비스 선택을 확인해주세요.")
    store.setServices(res.locals.admin.id, target, values)
    res.redirect(303, "/admin")
  })
  router.get("/security", async (_req, res) => {
    const backups = options.backups ? await options.backups.list() : []
    const csrf = `<input type="hidden" name="csrf" value="${esc(res.locals.admin.csrf)}">`
    const current = `<label>현재 관리자 비밀번호 <input name="currentPassword" type="password" autocomplete="current-password" maxlength="256" required></label>`
    res.send(page(`<h1>복구·백업 관리</h1><h2>관리자 복구 코드</h2><p>발급 시각: ${stamp(store.recoveryCreated(res.locals.admin.id))}. 코드는 한 번만 표시합니다. 새로 발급하거나 로그인 정보를 변경하면 기존 코드는 무효가 됩니다.</p><form method="post" action="/admin/recovery-code">${csrf}${current}<button>복구 코드 새로 발급</button></form><h2>계정·사용량 백업</h2><p>하루 한 번 자동 백업하며 최근 7개를 보관합니다. 같은 서버 저장공간의 백업이므로 다운로드한 사본도 별도로 보관하세요. 파일에는 비밀번호 해시가 포함됩니다. API 인증키와 로그인 토큰은 포함하지 않습니다.</p><p>최근 백업: ${backups[0] ? esc(backups[0]) : "아직 없음"}</p><form method="post" action="/admin/backup">${csrf}${current}<button${options.backups ? "" : " disabled"}>현재 백업 다운로드</button></form><h2>백업 파일로 복원</h2><p>선택한 시점의 계정·권한·사용량으로 되돌리고 모든 직원의 로그인 연결과 복구 코드를 종료합니다. 복원 직전 백업도 자동 저장합니다.</p><form method="post" action="/admin/restore" enctype="multipart/form-data">${csrf}${current}<label>백업 JSON 파일 <input name="backup" type="file" accept=".json,application/json" required></label><label>확인을 위해 ‘복원’ 입력 <input name="confirmation" required></label><button class="danger">백업으로 복원</button></form><p><a href="/admin">관리자 화면</a></p>`))
  })
  router.post("/recovery-code", async (req, res) => {
    if (!await reauthenticate(req, res)) return accountError(res, 401, "현재 관리자 비밀번호를 확인해주세요.")
    const code = store.issueRecoveryCode(res.locals.admin.id)
    res.send(page(`<h1>일회용 복구 코드</h1><p>이 화면에서만 표시됩니다. 비밀번호 관리자 등 별도 장소에 보관하세요.</p><p><code style="overflow-wrap:anywhere">${code}</code></p><p><a href="/admin/security">복구·백업 관리로 돌아가기</a></p>`))
  })
  router.post("/backup", async (req, res) => {
    if (!options.backups) return accountError(res, 503, "백업 저장공간이 설정되지 않았습니다.")
    if (!await reauthenticate(req, res)) return accountError(res, 401, "현재 관리자 비밀번호를 확인해주세요.")
    const name = await options.backups.create()
    const contents = await options.backups.read(name)
    if (!await sessions.find(res.locals.admin.key)) return accountError(res, 401, "다시 로그인해주세요.")
    store.audit(res.locals.admin.id, res.locals.admin.id, "backup")
    res.attachment(name).type("application/json").send(contents)
  })
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 3, parts: 5, fieldSize: 1024 } })
  router.post("/restore", upload.single("backup"), async (req, res) => {
    if (!options.backups || !options.bootstrapEmployees || !options.adminRoots) return accountError(res, 503, "복원 설정이 없습니다.")
    if (!equal(req.body?.csrf, res.locals.admin.csrf)) return accountError(res, 403, "복원 화면을 다시 열어주세요.")
    if (req.body?.confirmation !== "복원" || !req.file) return accountError(res, 400, "백업 파일과 확인 문구를 확인해주세요.")
    if (!await reauthenticate(req, res)) return accountError(res, 401, "현재 관리자 비밀번호를 확인해주세요.")
    const snapshot = options.backups.validate(req.file.buffer)
    await options.backups.create()
    if (!await sessions.find(res.locals.admin.key)) return accountError(res, 401, "다시 로그인해주세요.")
    store.restoreOperational(snapshot.tables, snapshot.accounts, options.bootstrapEmployees, options.adminRoots, snapshot.usageStartedAt)
    employees.clear(); for (const [id, employee] of snapshot.accounts) employees.set(id, employee)
    adminIds.clear(); for (const root of options.adminRoots) adminIds.add(store.resolveAccountId(root))
    store.audit("restore", "all", "restore")
    res.clearCookie(cookieName, cookieOptions)
    res.send(page('<h1>복원 완료</h1><p>백업 시점의 관리자 아이디·비밀번호로 다시 로그인하세요. 모든 직원도 MCP를 다시 연결해야 합니다.</p><a href="/admin/login">관리자 로그인</a>'))
  })
  router.get("/reset", (req, res) => {
    const id = req.query.target
    if (typeof id !== "string" || !employees.has(id) || adminIds.has(id)) return accountError(res, 403, "일반 직원 계정만 초기화할 수 있습니다.")
    res.send(page(`<h1>직원 비밀번호 초기화</h1><p>대상: <strong>${esc(id)}</strong>. 저장하면 이 직원의 기존 연결은 종료됩니다.</p><form method="post" action="/admin/reset"><input type="hidden" name="csrf" value="${esc(res.locals.admin.csrf)}"><input type="hidden" name="target" value="${esc(id)}"><label>현재 관리자 비밀번호 <input name="currentPassword" type="password" autocomplete="current-password" maxlength="256" required></label><label>직원 새 비밀번호 <input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><label>직원 새 비밀번호 확인 <input name="repeat" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><button>비밀번호 초기화 저장</button></form><a href="/admin">취소</a>`))
  })
  router.post("/reset", async (req, res) => {
    const { target, password, repeat } = req.body || {}, employee = employees.get(target)
    if (!employee || adminIds.has(employee.id)) return accountError(res, 403, "일반 직원 계정만 초기화할 수 있습니다.")
    if (typeof password !== "string" || password !== repeat || password.length < 12 || Buffer.byteLength(password) > 256) return accountError(res, 400, "새 비밀번호를 12자 이상으로 두 번 동일하게 입력해주세요.")
    if (!await reauthenticate(req, res)) return accountError(res, 401, "현재 관리자 비밀번호를 확인해주세요.")
    const next = { id: employee.id, passwordHash: await hashPassword(password) }
    if (employees.get(employee.id) !== employee || !await sessions.find(res.locals.admin.key)) return accountError(res, 409, "계정 상태가 변경되었습니다. 다시 확인해주세요.")
    store.changeAdminAccount(employee, next, { actor: res.locals.admin.id, action: "password_reset" })
    employees.set(next.id, next)
    res.send(page('<h1>직원 비밀번호 초기화 완료</h1><p>직원은 새 비밀번호로 MCP에 다시 연결할 수 있습니다.</p><a href="/admin">관리자 화면</a>'))
  })
  router.get("/profile", (_req, res) => {
    res.send(page(`<h1>내 로그인 정보 변경</h1><p>본인 관리자 아이디와 비밀번호를 변경합니다. 아이디는 영문·숫자·점·밑줄·하이픈 3~64자이며 대소문자를 구분합니다. 새 비밀번호를 비워두면 현재 비밀번호를 유지합니다.</p>
      <form method="post" action="/admin/profile"><input type="hidden" name="csrf" value="${esc(res.locals.admin.csrf)}">
      <label for="profile-id">변경할 아이디</label><input id="profile-id" name="username" value="${esc(res.locals.admin.id)}" minlength="3" maxlength="64" autocomplete="username" required>
      <label for="current-password">현재 비밀번호</label><input id="current-password" name="currentPassword" type="password" maxlength="256" autocomplete="current-password" required>
      <label for="profile-password">새 비밀번호 (선택)</label><input id="profile-password" name="password" type="password" minlength="12" maxlength="256" autocomplete="new-password">
      <label for="profile-repeat">새 비밀번호 확인</label><input id="profile-repeat" name="repeat" type="password" minlength="12" maxlength="256" autocomplete="new-password">
      <p>저장하면 본인의 관리자 로그인과 모든 MCP 연결이 종료됩니다. 새 정보로 다시 로그인하세요. 관리자 권한과 기존 사용량은 유지되고, 이전 아이디는 재사용할 수 없습니다. 다른 직원의 연결은 유지됩니다.</p><p class="actions"><button>로그인 정보 변경 저장</button><a class="button secondary" href="/admin">취소</a></p></form>`))
  })
  router.post("/profile", async (req, res) => {
    const previous = employees.get(res.locals.admin.id)
    const { username: id, currentPassword, password = "", repeat = "" } = req.body || {}
    if (!previous || !store.hit(`admin-profile:${digest(previous.id)}`, 5, 300)) return accountError(res, 429, "변경 시도가 많습니다. 5분 뒤 다시 시도해주세요.")
    if (typeof id !== "string" || !/^[a-zA-Z0-9._-]{3,64}$/.test(id)) return accountError(res, 400, "아이디 형식을 확인해주세요.")
    if (typeof password !== "string" || password !== repeat || (password !== "" && (password.length < 12 || Buffer.byteLength(password) > 256))) return accountError(res, 400, "새 비밀번호는 12자 이상, UTF-8 256바이트 이하로 두 번 동일하게 입력해주세요.")
    if (!await verifyPassword(currentPassword, previous.passwordHash)) return accountError(res, 401, "현재 비밀번호가 올바르지 않습니다.")
    if (id === previous.id && password === "") return accountError(res, 400, "변경할 아이디 또는 새 비밀번호를 입력해주세요.")
    const passwordHash = password === "" ? previous.passwordHash : await hashPassword(password)
    const activeSession = await sessions.find(res.locals.admin.key)
    if (employees.get(previous.id) !== previous || !adminIds.has(previous.id) || store.isBlocked(previous.id) || !activeSession) return accountError(res, 401, "로그인 상태가 변경되었습니다. 다시 로그인해주세요.")
    if (id !== previous.id && (employees.has(id) || store.wasManaged(id))) return accountError(res, 409, "이미 사용한 아이디입니다. 다른 아이디를 입력해주세요.")
    const next = { id, passwordHash }
    store.changeAdminAccount(previous, next)
    employees.delete(previous.id)
    employees.set(id, next)
    adminIds.delete(previous.id)
    adminIds.add(id)
    res.clearCookie(cookieName, cookieOptions)
    res.clearCookie(preName, cookieOptions)
    res.send(page(`<h1>로그인 정보 변경 완료</h1><p>관리자 아이디: <strong>${esc(id)}</strong></p><p>관리자 권한과 기존 사용량은 유지됩니다. 새 정보로 관리자 화면에 로그인하고, ChatGPT의 각 MCP도 다시 연결해주세요.</p><a class="button" href="/admin/login">관리자 다시 로그인</a>`))
  })
  router.post("/employees", async (req, res) => {
    const { username: id, password, repeat } = req.body || {}
    if (typeof id !== "string" || !/^[a-zA-Z0-9._-]{3,64}$/.test(id)) return accountError(res, 400, "아이디는 영문·숫자·점·밑줄·하이픈 3~64자로 입력해주세요.")
    if (typeof password !== "string" || password !== repeat || password.length < 12 || Buffer.byteLength(password) > 256) return accountError(res, 400, "비밀번호를 12자 이상, UTF-8 256바이트 이하로 두 번 동일하게 입력해주세요.")
    if (employees.has(id) || store.wasManaged(id)) return accountError(res, 409, "이미 사용한 아이디입니다. 기존 계정 또는 제거한 계정과 다른 아이디를 입력해주세요.")
    if (employees.size >= 1000) return accountError(res, 409, "계정은 최대 1,000개까지 등록할 수 있습니다.")
    const passwordHash = await hashPassword(password)
    // Recheck after asynchronous hashing: concurrent submissions cannot overwrite an account.
    if (employees.has(id) || store.wasManaged(id) || employees.size >= 1000) return accountError(res, 409, "계정 목록이 변경되었습니다. 새 아이디와 등록 가능 계정 수를 확인해주세요.")
    const employee = { id, passwordHash }
    store.addEmployee(res.locals.admin.id, employee)
    employees.set(id, employee)
    res.redirect(303, "/admin?notice=created")
  })
  router.get("/remove", (req, res) => {
    const id = req.query.target
    if (typeof id !== "string" || !employees.has(id)) return accountError(res, 404, "등록된 계정이 아닙니다.")
    if (adminIds.has(id)) return accountError(res, 403, "관리자 계정은 제거할 수 없습니다.")
    res.send(page(`<h1>직원 계정 제거</h1><p><strong>${esc(id)}</strong> 계정을 제거하면 기존 연결과 진행 중인 로그인이 종료되고 다시 로그인할 수 없습니다. 기존 사용량과 관리 기록은 남습니다. 제거한 아이디는 재사용할 수 없습니다.</p>
      <form method="post" action="/admin/remove"><input type="hidden" name="csrf" value="${esc(res.locals.admin.csrf)}"><input type="hidden" name="target" value="${esc(id)}"><label for="confirm-id">제거할 아이디를 다시 입력하세요</label><input id="confirm-id" name="confirmTarget" maxlength="64" autocomplete="off" required><p class="actions"><button class="danger">계정 영구 제거</button><a class="button secondary" href="/admin">취소</a></p></form>`))
  })
  router.post("/remove", (req, res) => {
    const { target, confirmTarget } = req.body || {}
    if (typeof target !== "string" || !employees.has(target)) return accountError(res, 404, "등록된 계정이 아닙니다.")
    if (adminIds.has(target)) return accountError(res, 403, "관리자 계정은 제거할 수 없습니다.")
    if (confirmTarget !== target) return accountError(res, 400, "확인용 아이디가 일치하지 않습니다. 계정은 제거되지 않았습니다.")
    store.manageAccount(res.locals.admin.id, target, "remove")
    employees.delete(target)
    res.redirect(303, "/admin?notice=removed")
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
