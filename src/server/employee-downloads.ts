import express, { type Express, type Request } from "express"
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { verifyPassword, type Employee } from "./oauth-accounts.js"
import type { OAuthStore } from "./oauth-store.js"

const digest = (s: string) => createHash("sha256").update(s).digest("hex")
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))
const cookie = (req: Request, name: string) => (req.headers.cookie || "").split(";").map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1) || ""
const equal = (a: unknown, b: string) => typeof a === "string" && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** Bounded ephemeral files. URLs alone never authorize downloads. */
export function installEmployeeDownloads(app: Express, options: {
  issuer: string; local: boolean; store: OAuthStore; employees: Map<string, Employee>; secret: string; dummyHash: string;
}) {
  const { issuer, local, store, employees, secret, dummyHash } = options
  const files = new Map<string, { owner: string; version: string; name: string; bytes: Buffer; expires: number }>()
  const Adapter = store.adapter()
  const sessions = new Adapter("DownloadSession")
  const sessionName = local ? "mcp_download" : "__Host-mcp_download"
  const preName = local ? "mcp_download_csrf" : "__Host-mcp_download_csrf"
  const cookieOptions = { httpOnly: true, secure: !local, sameSite: "strict" as const, path: "/" }
  const csrf = (nonce: string, id: string) => createHmac("sha256", secret).update(`download:${nonce}:${id}`).digest("hex")
  const cleanup = () => { for (const [id, file] of files) if (file.expires <= Date.now()) files.delete(id) }
  const timer = setInterval(cleanup, 60000).unref()
  const router = express.Router()
  router.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" })
    next()
  })
  const page = (body: string) => `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KOSIS 파일 다운로드</title><style>body{font:16px/1.7 system-ui;background:#f3f5f8;color:#182337}main{max-width:440px;margin:50px auto;padding:30px;background:white;border-radius:14px}label{display:block;margin-top:18px}input,button{padding:12px;font:inherit;max-width:90%}button{margin-top:24px;background:#164eb5;color:white;border:0;border-radius:6px}</style><main>${body}</main></html>`
  router.get("/:id", async (req, res) => {
    cleanup()
    if (!/^[a-f0-9]{64}$/.test(req.params.id)) return res.status(404).send(page("<h1>파일을 찾을 수 없습니다</h1>"))
    const token = cookie(req, sessionName)
    const session = /^[a-f0-9]{64}$/.test(token) ? await sessions.find(digest(token)) : undefined
    const employee = session?.accountId ? employees.get(session.accountId) : undefined
    if (!employee || session?.passwordVersion !== digest(employee.passwordHash) || !store.canUse(employee.id, "kosis")) {
      const nonce = randomBytes(32).toString("hex")
      res.cookie(preName, nonce, { ...cookieOptions, maxAge: 600000 })
      return res.send(page(`<h1>KOSIS 엑셀 다운로드</h1><p>파일을 생성한 직원 계정으로 로그인해주세요. 파일은 최대 24시간 보관하며 서버 재시작 시 만료됩니다.</p><form method="post"><input type="hidden" name="csrf" value="${csrf(nonce, req.params.id)}"><label>직원 아이디 <input name="username" autocomplete="username" maxlength="64" required></label><label>비밀번호 <input name="password" type="password" autocomplete="current-password" maxlength="256" required></label><button>로그인 후 다운로드</button></form>`))
    }
    const file = files.get(req.params.id)
    if (!file || file.owner !== employee.id || file.version !== digest(employee.passwordHash)) return res.status(404).send(page("<h1>다운로드할 수 없습니다</h1><p>파일이 만료되었거나 이 계정에서 생성한 파일이 아닙니다. KOSIS에서 다시 생성해주세요.</p>"))
    res.attachment(file.name).type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(file.bytes)
  })
  router.post("/:id", express.urlencoded({ extended: false, limit: "4kb" }), async (req, res) => {
    const nonce = cookie(req, preName)
    if (!/^[a-f0-9]{64}$/.test(req.params.id) || !/^[a-f0-9]{64}$/.test(nonce) || req.get("origin") !== issuer || !equal(req.body?.csrf, csrf(nonce, req.params.id))) return res.status(403).send("다운로드 링크를 다시 열어주세요.")
    const id = typeof req.body.username === "string" ? req.body.username.slice(0, 64) : ""
    if (!store.hit(`download:${digest(id)}`, 10, 300) || !store.hit("download-global", 100, 60)) return res.status(429).send("잠시 후 다시 시도해주세요.")
    const employee = employees.get(id)
    const valid = await verifyPassword(req.body.password, employee?.passwordHash || dummyHash)
    if (!employee || !valid || employees.get(id) !== employee || !store.canUse(id, "kosis")) return res.status(401).send(page(`<h1>로그인 정보를 확인해주세요</h1><a href="/downloads/${esc(req.params.id)}">다시 로그인</a>`))
    const token = randomBytes(32).toString("hex")
    await sessions.upsert(digest(token), { accountId: id, passwordVersion: digest(employee.passwordHash) }, 900)
    res.clearCookie(preName, cookieOptions).cookie(sessionName, token, { ...cookieOptions, maxAge: 900000 }).redirect(303, `/downloads/${req.params.id}`)
  })
  app.use("/downloads", router)
  return {
    save(owner: string, bytes: Buffer, filename: string) {
      cleanup()
      const employee = employees.get(owner)
      if (!employee || !store.canUse(owner, "kosis")) throw new Error("직원 로그인 권한을 확인해주세요.")
      const total = [...files.values()].reduce((n, f) => n + f.bytes.length, 0)
      if (bytes.length > 5 * 1024 * 1024 || total + bytes.length > 50 * 1024 * 1024 || files.size >= 50 || [...files.values()].filter(f => f.owner === owner).length >= 10) throw new Error("다운로드 저장 한도에 도달했습니다. 파일 크기를 줄이거나 기존 파일 만료 후 다시 시도해주세요.")
      const id = randomBytes(32).toString("hex"), expires = Date.now() + 86400000
      const name = filename.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 180)
      files.set(id, { owner, version: digest(employee.passwordHash), name, bytes, expires })
      return { download_url: `${issuer}/downloads/${id}`, filename: name, expires_at: new Date(expires).toISOString(), note: "생성한 직원 계정으로 로그인해 다운로드합니다. 서버 재시작 시 일찍 만료될 수 있습니다." }
    },
    close() { clearInterval(timer); files.clear() },
  }
}
