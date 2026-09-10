import { DatabaseSync } from "node:sqlite"
import { mkdirSync, chmodSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto"
import { errors, type AdapterPayload, type AdapterConstructor } from "oidc-provider"
import type { Employee } from "./oauth-accounts.js"
import { SERVICE_IDS, type ServiceId } from "./services.js"
import type { TrafficEvent } from "./traffic.js"

export const OPERATIONAL_TABLES = {
  managed_employees: ["id", "password_hash", "removed"], account_renames: ["old_id", "new_id"],
  account_controls: ["account_id", "blocked", "last_login", "last_request"],
  admin_audit: ["id", "at", "actor", "target", "action"], employee_usage: ["day", "account_id", "service", "calls"],
  service_permissions: ["account_id", "service", "allowed"], service_metrics: ["service", "requests", "errors", "last_success", "last_error"],
} as const

/** One Railway replica backed by a mounted volume; never an in-memory production adapter. */
export class OAuthStore {
  private db: DatabaseSync
  constructor(path: string, issuer: string) {
    if (path !== ":memory:" && !isAbsolute(path)) throw new Error("OAUTH_DB_PATH must be absolute.")
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ":memory:") chmodSync(path, 0o600)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS objects (
        model TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        expires INTEGER, uid TEXT, user_code TEXT, grant_id TEXT,
        PRIMARY KEY(model,id)
      );
      CREATE INDEX IF NOT EXISTS objects_uid ON objects(model,uid);
      CREATE INDEX IF NOT EXISTS objects_grant ON objects(grant_id);
      CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER, expires INTEGER);
      CREATE TABLE IF NOT EXISTS active_connections (
        account_id TEXT PRIMARY KEY, login_id TEXT NOT NULL, grant_id TEXT
      );
      CREATE TABLE IF NOT EXISTS account_controls (
        account_id TEXT PRIMARY KEY, blocked INTEGER NOT NULL DEFAULT 0,
        last_login INTEGER, last_request INTEGER
      );
      CREATE TABLE IF NOT EXISTS admin_audit (
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL,
        target TEXT NOT NULL, action TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS employee_usage (
        day TEXT NOT NULL, account_id TEXT NOT NULL, calls INTEGER NOT NULL,
        PRIMARY KEY(day, account_id)
      );
      CREATE TABLE IF NOT EXISTS managed_employees (
        id TEXT PRIMARY KEY, password_hash TEXT, removed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS account_renames (old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_recovery (account_id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS service_permissions (account_id TEXT NOT NULL, service TEXT NOT NULL, allowed INTEGER NOT NULL, PRIMARY KEY(account_id,service));
      CREATE TABLE IF NOT EXISTS service_metrics (service TEXT PRIMARY KEY, requests INTEGER NOT NULL, errors INTEGER NOT NULL, last_success INTEGER, last_error INTEGER);
      CREATE TABLE IF NOT EXISTS http_traffic(day TEXT, category TEXT, method TEXT, status INTEGER, auth TEXT, requests INTEGER NOT NULL, calls INTEGER NOT NULL, last_at INTEGER NOT NULL, PRIMARY KEY(day,category,method,status,auth));
      CREATE TABLE IF NOT EXISTS recent_traffic(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, category TEXT, method TEXT, status INTEGER, auth TEXT, account_id TEXT, calls INTEGER NOT NULL);
    `)
    if (!this.db.prepare("PRAGMA table_info(active_connections)").all().some(row => row.name === "service")) this.db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE active_connections RENAME TO old_connections;
      CREATE TABLE active_connections (account_id TEXT NOT NULL, service TEXT NOT NULL, login_id TEXT NOT NULL, grant_id TEXT, PRIMARY KEY(account_id,service));
      INSERT INTO active_connections SELECT account_id,'law',login_id,grant_id FROM old_connections;
      DROP TABLE old_connections;
      COMMIT;
    `)
    if (!this.db.prepare("PRAGMA table_info(employee_usage)").all().some(row => row.name === "service")) this.db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE employee_usage RENAME TO old_usage;
      CREATE TABLE employee_usage (day TEXT NOT NULL, account_id TEXT NOT NULL, service TEXT NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY(day,account_id,service));
      INSERT INTO employee_usage SELECT day,account_id,'law',calls FROM old_usage;
      DROP TABLE old_usage;
      COMMIT;
    `)
    const savedIssuer = this.setting("issuer", () => issuer)
    if (savedIssuer !== issuer) { this.close(); throw new Error("OAuth database issuer differs from OAUTH_ISSUER. Use the original issuer or a new volume.") }
    this.setting("usage-started-at", () => String(Math.floor(Date.now() / 1000)))
    this.setting("traffic-started-at", () => String(Math.floor(Date.now() / 1000)))
  }
  /** Database additions/removals override bootstrap environment accounts on every restart. */
  loadEmployees(bootstrap: Map<string, Employee>): Map<string, Employee> {
    const employees = new Map(bootstrap)
    for (const row of this.db.prepare("SELECT id,password_hash,removed FROM managed_employees").all()) {
      const id = String(row.id)
      if (row.removed === 1) employees.delete(id)
      else employees.set(id, { id, passwordHash: String(row.password_hash) })
    }
    if (employees.size > 1000) throw new Error("At most 1000 active employee accounts are allowed.")
    return employees
  }
  wasManaged(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM managed_employees WHERE id=?").get(id)
      || !!this.db.prepare("SELECT 1 FROM employee_usage WHERE account_id=? LIMIT 1").get(id)
  }
  resolveAccountId(id: string): string {
    const seen = new Set<string>()
    while (!seen.has(id)) {
      seen.add(id)
      const row = this.db.prepare("SELECT new_id FROM account_renames WHERE old_id=?").get(id)
      if (!row) return id
      id = String(row.new_id)
    }
    throw new Error("Invalid account rename chain.")
  }
  /** Commit credentials, role alias, history migration and revocation as one atomic change. */
  changeAdminAccount(previous: Employee, next: Employee, options: { actor?: string; action?: string; recoveryHash?: string } = {}) {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      if (options.recoveryHash && this.db.prepare("DELETE FROM admin_recovery WHERE account_id=? AND code_hash=?").run(previous.id, options.recoveryHash).changes !== 1) throw new Error("Invalid recovery code.")
      this.db.prepare("DELETE FROM admin_recovery WHERE account_id=?").run(previous.id)
      if (previous.id !== next.id && this.wasManaged(next.id)) throw new Error("Account ID already used.")
      this.db.prepare(`INSERT INTO managed_employees(id,password_hash,removed) VALUES(?,?,0)
        ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash, removed=0`).run(next.id, next.passwordHash)
      this.db.prepare("DELETE FROM active_connections WHERE account_id=?").run(previous.id)
      const grants = this.db.prepare("SELECT id FROM objects WHERE model='Grant' AND json_extract(payload,'$.accountId')=?").all(previous.id)
      for (const grant of grants) this.revokeGrant(String(grant.id))
      this.db.prepare(`DELETE FROM objects WHERE json_extract(payload,'$.accountId')=?
        OR (model='Interaction' AND (json_extract(payload,'$.session.accountId')=? OR json_extract(payload,'$.result.login.accountId')=?))`).run(previous.id, previous.id, previous.id)
      if (previous.id !== next.id) {
        this.db.prepare(`INSERT INTO managed_employees(id,password_hash,removed) VALUES(?,NULL,1)
          ON CONFLICT(id) DO UPDATE SET password_hash=NULL, removed=1`).run(previous.id)
        this.db.prepare("INSERT INTO account_renames(old_id,new_id) VALUES(?,?)").run(previous.id, next.id)
        this.db.prepare("UPDATE employee_usage SET account_id=? WHERE account_id=?").run(next.id, previous.id)
        this.db.prepare("UPDATE account_controls SET account_id=? WHERE account_id=?").run(next.id, previous.id)
        this.db.prepare("UPDATE service_permissions SET account_id=? WHERE account_id=?").run(next.id, previous.id)
        this.db.prepare("INSERT INTO account_controls(account_id,blocked) VALUES(?,1)").run(previous.id)
      }
      const fingerprints = JSON.parse(this.setting("accounts", () => "{}")) as Record<string, string>
      delete fingerprints[previous.id]
      fingerprints[next.id] = createHash("sha256").update(next.passwordHash).digest("hex")
      this.db.prepare("UPDATE settings SET value=? WHERE key='accounts'").run(JSON.stringify(fingerprints))
      this.db.prepare("INSERT INTO admin_audit(at,actor,target,action) VALUES(?,?,?,?)").run(Math.floor(Date.now() / 1000), options.actor || previous.id, next.id, options.action || "credentials")
      this.db.exec("COMMIT")
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  issueRecoveryCode(accountId: string): string {
    const code = randomBytes(32).toString("hex")
    this.db.prepare(`INSERT INTO admin_recovery VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET code_hash=excluded.code_hash,created=excluded.created`)
      .run(accountId, createHash("sha256").update(code).digest("hex"), Math.floor(Date.now() / 1000))
    this.audit(accountId, accountId, "recovery_issue")
    return code
  }
  recoveryMatches(accountId: string, code: string): boolean {
    return /^[a-f0-9]{64}$/.test(code) && !!this.db.prepare("SELECT 1 FROM admin_recovery WHERE account_id=? AND code_hash=?")
      .get(accountId, createHash("sha256").update(code).digest("hex"))
  }
  recoveryCreated(accountId: string): number | null {
    const row = this.db.prepare("SELECT created FROM admin_recovery WHERE account_id=?").get(accountId)
    return row ? Number(row.created) : null
  }
  audit(actor: string, target: string, action: string) {
    this.db.prepare("INSERT INTO admin_audit(at,actor,target,action) VALUES(?,?,?,?)").run(Math.floor(Date.now() / 1000), actor, target, action)
  }
  exportOperational() {
    const tables = Object.fromEntries(Object.entries(OPERATIONAL_TABLES).map(([name, columns]) => [name, this.db.prepare(`SELECT ${columns.join(",")} FROM ${name}`).all()]))
    return { tables, usageStartedAt: Number(this.setting("usage-started-at", () => String(Math.floor(Date.now() / 1000)))) }
  }
  restoreOperational(tables: Record<string, Record<string, string | number | null>[]>, accounts: Map<string, Employee>, bootstrap: Map<string, Employee>, adminRoots: string[], usageStartedAt: number) {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      for (const [name, columns] of Object.entries(OPERATIONAL_TABLES)) {
        this.db.exec(`DELETE FROM ${name}`)
        const statement = this.db.prepare(`INSERT INTO ${name}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`)
        for (const row of tables[name] || []) statement.run(...columns.map(column => row[column]))
      }
      for (const employee of accounts.values()) this.db.prepare(`INSERT INTO managed_employees VALUES(?,?,0)
        ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash,removed=0`).run(employee.id, employee.passwordHash)
      for (const id of bootstrap.keys()) if (!accounts.has(id)) this.db.prepare(`INSERT INTO managed_employees VALUES(?,NULL,1)
        ON CONFLICT(id) DO UPDATE SET password_hash=NULL,removed=1`).run(id)
      if (!adminRoots.length || adminRoots.some(root => !accounts.has(this.resolveAccountId(root)) || this.isBlocked(this.resolveAccountId(root)))) throw new Error("Backup does not contain an available configured administrator.")
      this.db.exec("DELETE FROM active_connections; DELETE FROM admin_recovery; DELETE FROM objects WHERE model<>'Client'")
      const fingerprints = Object.fromEntries([...accounts].map(([id, employee]) => [id, createHash("sha256").update(employee.passwordHash).digest("hex")]))
      this.db.prepare("UPDATE settings SET value=? WHERE key='accounts'").run(JSON.stringify(fingerprints))
      this.db.prepare("UPDATE settings SET value=? WHERE key='usage-started-at'").run(String(usageStartedAt))
      this.db.exec("COMMIT")
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  addEmployee(actor: string, employee: Employee) {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.prepare("INSERT INTO managed_employees(id,password_hash) VALUES(?,?)").run(employee.id, employee.passwordHash)
      this.db.prepare("INSERT INTO admin_audit(at,actor,target,action) VALUES(?,?,?,'create')").run(Math.floor(Date.now() / 1000), actor, employee.id)
      this.db.exec("COMMIT")
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  /** Accepted tools/call attempts, including eventual errors; never query text or tokens. */
  recordToolCalls(accountId: string, count: number, now = Date.now(), service: ServiceId = "law") {
    if (!Number.isSafeInteger(count) || count <= 0) return
    accountId = this.resolveAccountId(accountId)
    const day = new Date(now + 9 * 3600000).toISOString().slice(0, 10)
    this.db.prepare(`INSERT INTO employee_usage VALUES(?,?,?,?)
      ON CONFLICT(day,account_id,service) DO UPDATE SET calls=employee_usage.calls+excluded.calls`).run(day, accountId, service, count)
  }
  usageSummary(period: "today" | "month" | "all", accountIds: string[], now = Date.now(), service: ServiceId | "all" = "all") {
    const today = new Date(now + 9 * 3600000).toISOString().slice(0, 10)
    const from = period === "today" ? today : period === "month" ? today.slice(0, 7) + "-01" : "0000-01-01"
    const saved = this.db.prepare(`SELECT account_id, SUM(calls) AS calls FROM employee_usage
      WHERE day>=? AND day<=? AND (?='all' OR service=?) GROUP BY account_id`).all(from, today, service, service)
    const counts = new Map(saved.map(r => [String(r.account_id), Number(r.calls)]))
    const ids = [...new Set([...accountIds, ...counts.keys()])]
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0)
    return { total, startedAt: Number(this.setting("usage-started-at", () => String(Math.floor(now / 1000)))),
      rows: ids.map(id => ({ id, calls: counts.get(id) || 0, registered: accountIds.includes(id),
        percent: total ? (counts.get(id) || 0) / total * 100 : 0 })) }
  }
  /** A successful password check replaces the account's connection atomically. */
  beginLogin(accountId: string, interactionId = "", service: ServiceId = "law"): string {
    const loginId = randomBytes(32).toString("hex")
    this.db.exec("BEGIN IMMEDIATE")
    try {
      if (!this.canUse(accountId, service)) throw new errors.AccessDenied("Account or service disabled.")
      const previous = this.db.prepare("SELECT grant_id FROM active_connections WHERE account_id=? AND service=?").get(accountId, service)
      if (previous?.grant_id) this.revokeGrant(String(previous.grant_id), interactionId)
      this.db.prepare(`INSERT INTO active_connections VALUES(?,?,?,NULL)
        ON CONFLICT(account_id,service) DO UPDATE SET login_id=excluded.login_id, grant_id=NULL`).run(accountId, service, loginId)
      this.db.prepare(`INSERT INTO account_controls(account_id,last_login) VALUES(?,?)
        ON CONFLICT(account_id) DO UPDATE SET last_login=excluded.last_login`).run(accountId, Math.floor(Date.now() / 1000))
      this.db.exec("COMMIT")
      return loginId
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  isBlocked(accountId: string): boolean {
    return this.db.prepare("SELECT blocked FROM account_controls WHERE account_id=?").get(accountId)?.blocked === 1
  }
  recordRequest(accountId: string) {
    this.db.prepare(`INSERT INTO account_controls(account_id,last_request) VALUES(?,?)
      ON CONFLICT(account_id) DO UPDATE SET last_request=excluded.last_request`).run(accountId, Math.floor(Date.now() / 1000))
  }
  connectionSummary(accountId: string, service: ServiceId | "all" = "all") {
    const now = Math.floor(Date.now() / 1000)
    const controls = this.db.prepare("SELECT blocked,last_login,last_request FROM account_controls WHERE account_id=?").get(accountId)
    const connected = !this.isBlocked(accountId) && !!this.db.prepare(`SELECT 1 FROM active_connections c
      JOIN objects g ON g.model='Grant' AND g.id=c.grant_id
      JOIN objects t ON t.grant_id=c.grant_id AND t.model IN ('AccessToken','RefreshToken')
      WHERE c.account_id=? AND (?='all' OR c.service=?) AND g.expires>? AND t.expires>?
      AND (json_extract(t.payload,'$.exp') IS NULL OR json_extract(t.payload,'$.exp')>?)
      AND json_extract(t.payload,'$.consumed') IS NULL LIMIT 1`).get(accountId, service, service, now, now, now)
    return { id: accountId, blocked: controls?.blocked === 1, connected,
      lastLogin: controls?.last_login == null ? null : Number(controls.last_login),
      lastRequest: controls?.last_request == null ? null : Number(controls.last_request) }
  }
  manageAccount(actor: string, target: string, action: "disconnect" | "block" | "unblock" | "remove") {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      if (action !== "unblock") {
        this.db.prepare("DELETE FROM active_connections WHERE account_id=?").run(target)
        const grants = this.db.prepare("SELECT id FROM objects WHERE model='Grant' AND json_extract(payload,'$.accountId')=?").all(target)
        for (const grant of grants) this.revokeGrant(String(grant.id))
        this.db.prepare(`DELETE FROM objects WHERE (model<>'AdminSession' AND json_extract(payload,'$.accountId')=?)
          OR (model='Interaction' AND (json_extract(payload,'$.session.accountId')=? OR json_extract(payload,'$.result.login.accountId')=?))`).run(target, target, target)
      }
      if (action !== "disconnect") this.db.prepare(`INSERT INTO account_controls(account_id,blocked) VALUES(?,?)
        ON CONFLICT(account_id) DO UPDATE SET blocked=excluded.blocked`).run(target, action === "unblock" ? 0 : 1)
      if (action === "remove") {
        this.db.prepare(`INSERT INTO managed_employees(id,password_hash,removed) VALUES(?,NULL,1)
          ON CONFLICT(id) DO UPDATE SET password_hash=NULL, removed=1`).run(target)
        this.revokeAdminSessions(target)
      }
      this.db.prepare("INSERT INTO admin_audit(at,actor,target,action) VALUES(?,?,?,?)").run(Math.floor(Date.now() / 1000), actor, target, action)
      this.db.exec("COMMIT")
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  auditLog() {
    return this.db.prepare("SELECT at,actor,target,action FROM admin_audit ORDER BY id DESC LIMIT 30").all()
  }
  revokeAdminSessions(accountId: string) {
    this.db.prepare("DELETE FROM objects WHERE model='AdminSession' AND json_extract(payload,'$.accountId')=?").run(accountId)
  }
  isCurrentLogin(accountId: string, loginId: unknown, service: ServiceId = "law"): boolean {
    return this.canUse(accountId, service) && typeof loginId === "string" && !!this.db.prepare("SELECT 1 FROM active_connections WHERE account_id=? AND service=? AND login_id=?").get(accountId, service, loginId)
  }
  activateGrant(accountId: string, loginId: unknown, grantId: string, service: ServiceId = "law") {
    if (!this.canUse(accountId, service) || typeof loginId !== "string" || this.db.prepare(`UPDATE active_connections SET grant_id=?
      WHERE account_id=? AND service=? AND login_id=? AND (grant_id IS NULL OR grant_id=?)`).run(grantId, accountId, service, loginId, grantId).changes !== 1) {
      throw new errors.InvalidGrant("This login was replaced. Start a new login.")
    }
  }
  private currentObject(model: string, id: string, payload: AdapterPayload): boolean {
    if (!["Grant", "AccessToken", "RefreshToken", "AuthorizationCode"].includes(model)) return true
    const grantId = model === "Grant" ? id : payload.grantId
    if (typeof payload.accountId !== "string" || typeof grantId !== "string") return false
    if (this.isBlocked(payload.accountId)) return false
    const connection = this.db.prepare("SELECT service FROM active_connections WHERE account_id=? AND grant_id=?").get(payload.accountId, grantId)
    return !!connection && this.canUse(payload.accountId, connection.service as ServiceId)
  }
  canUse(accountId: string, service: ServiceId): boolean {
    return !this.isBlocked(accountId) && this.db.prepare("SELECT allowed FROM service_permissions WHERE account_id=? AND service=?").get(accountId, service)?.allowed !== 0
  }
  setServices(actor: string, accountId: string, allowed: ServiceId[]) {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      for (const service of SERVICE_IDS) {
        this.db.prepare(`INSERT INTO service_permissions VALUES(?,?,?) ON CONFLICT(account_id,service) DO UPDATE SET allowed=excluded.allowed`).run(accountId, service, allowed.includes(service) ? 1 : 0)
        if (!allowed.includes(service)) {
          const previous = this.db.prepare("SELECT grant_id FROM active_connections WHERE account_id=? AND service=?").get(accountId, service)
          if (previous?.grant_id) this.revokeGrant(String(previous.grant_id))
          this.db.prepare("DELETE FROM active_connections WHERE account_id=? AND service=?").run(accountId, service)
        }
      }
      this.audit(actor, accountId, "services")
      this.db.exec("COMMIT")
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  serviceResult(service: ServiceId, failed: boolean) {
    const now = Math.floor(Date.now() / 1000)
    this.db.prepare(`INSERT INTO service_metrics VALUES(?,1,?,?,?) ON CONFLICT(service) DO UPDATE SET requests=service_metrics.requests+1,
      errors=service_metrics.errors+excluded.errors,last_success=COALESCE(excluded.last_success,service_metrics.last_success),last_error=COALESCE(excluded.last_error,service_metrics.last_error)`)
      .run(service, failed ? 1 : 0, failed ? null : now, failed ? now : null)
  }
  serviceAllowed(accountId: string, service: ServiceId) {
    return this.db.prepare("SELECT allowed FROM service_permissions WHERE account_id=? AND service=?").get(accountId, service)?.allowed !== 0
  }
  serviceMetrics(service: ServiceId) {
    return this.db.prepare("SELECT requests,errors,last_success,last_error FROM service_metrics WHERE service=?").get(service) || { requests: 0, errors: 0, last_success: null, last_error: null }
  }
  recordTraffic(event: TrafficEvent, now = Date.now()) {
    const day = new Date(now + 9 * 3600000).toISOString().slice(0, 10), at = Math.floor(now / 1000)
    const method = ["GET", "HEAD", "POST", "DELETE", "OPTIONS"].includes(event.method) ? event.method : "OTHER"
    const calls = Number.isSafeInteger(event.calls) && event.calls > 0 ? event.calls : 0
    this.db.prepare(`INSERT INTO http_traffic VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(day,category,method,status,auth) DO UPDATE SET
      requests=http_traffic.requests+1,calls=http_traffic.calls+excluded.calls,last_at=excluded.last_at`)
      .run(day, event.group, method, event.status, event.auth, calls, at)
    if (["law", "g2b", "kosis", "oauth"].includes(event.group)) {
      this.db.prepare("INSERT INTO recent_traffic(at,category,method,status,auth,account_id,calls) VALUES(?,?,?,?,?,?,?)")
        .run(at, event.group, method, event.status, event.auth, event.accountId || null, calls)
      this.db.exec("DELETE FROM recent_traffic WHERE id NOT IN (SELECT id FROM recent_traffic ORDER BY id DESC LIMIT 100)")
    }
  }
  trafficSummary(period: "today" | "month" | "all", now = Date.now()) {
    const day = new Date(now + 9 * 3600000).toISOString().slice(0, 10)
    const since = period === "today" ? day : period === "month" ? day.slice(0, 7) + "-01" : "0000"
    const rows = this.db.prepare(`SELECT category,auth,SUM(requests) AS requests,SUM(calls) AS calls,
      SUM(CASE WHEN status>=400 THEN requests ELSE 0 END) AS errors,
      SUM(CASE WHEN status IN (401,403) THEN requests ELSE 0 END) AS denied, MAX(last_at) AS last_at
      FROM http_traffic WHERE day>=? GROUP BY category,auth`).all(since)
    return { startedAt: Number(this.setting("traffic-started-at", () => String(Math.floor(now / 1000)))), rows,
      recent: this.db.prepare("SELECT at,category,method,status,auth,account_id,calls FROM recent_traffic ORDER BY id DESC LIMIT 30").all() }
  }
  setting(key: string, create: () => string): string {
    const saved = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key)
    if (saved) return String(saved.value)
    const value = create()
    this.db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(key, value)
    return value
  }
  keys() {
    return {
      cookie: this.setting("cookie-key", () => randomBytes(48).toString("base64url")),
      jwks: JSON.parse(this.setting("jwks", () => {
        const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
        return JSON.stringify({ keys: [{ ...privateKey.export({ format: "jwk" }), kid: randomBytes(16).toString("hex"), use: "sig", alg: "RS256" }] })
      })),
    }
  }
  /** Reset outstanding sessions/tokens when the administrator removes an ID or changes a password. */
  synchronizeAccounts(fingerprints: Record<string, string>) {
    const previous = JSON.parse(this.setting("accounts", () => "{}")) as Record<string, string>
    for (const [id, fingerprint] of Object.entries(previous)) {
      if (fingerprints[id] !== fingerprint) {
        const grants = this.db.prepare("SELECT id FROM objects WHERE model='Grant' AND json_extract(payload,'$.accountId')=?").all(id)
        for (const grant of grants) this.revokeGrant(String(grant.id))
        this.db.prepare("DELETE FROM objects WHERE json_extract(payload,'$.accountId')=?").run(id)
        this.db.prepare("DELETE FROM active_connections WHERE account_id=?").run(id)
      }
    }
    this.db.prepare("UPDATE settings SET value=? WHERE key='accounts'").run(JSON.stringify(fingerprints))
    this.cleanup()
  }
  hit(key: string, maximum: number, seconds: number): boolean {
    const now = Math.floor(Date.now() / 1000)
    this.db.prepare(`INSERT INTO limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN limits.expires<=? THEN 1 ELSE limits.count+1 END,
      expires=CASE WHEN limits.expires<=? THEN excluded.expires ELSE limits.expires END`).run(key, now + seconds, now, now)
    return Number(this.db.prepare("SELECT count FROM limits WHERE key=?").get(key)!.count) <= maximum
  }
  cleanup() {
    const now = Math.floor(Date.now() / 1000)
    this.db.prepare("DELETE FROM objects WHERE expires IS NOT NULL AND expires<=?").run(now)
    this.db.prepare("DELETE FROM limits WHERE expires<=?").run(now)
    this.db.prepare("DELETE FROM admin_audit WHERE at<?").run(now - 90 * 86400)
  }
  private revokeGrant(id: string, preserveInteraction = "") {
    this.db.prepare(`DELETE FROM objects WHERE (grant_id=? OR (model='Grant' AND id=?))
      AND NOT (model='Interaction' AND id=?)`).run(id, id, preserveInteraction)
  }
  adapter(): AdapterConstructor {
    const store = this
    return class SqliteAdapter {
      constructor(private model: string) {}
      async upsert(id: string, payload: AdapterPayload, expiresIn?: number) {
        // Fence late writes from an old refresh/code exchange after a new login.
        if (!store.currentObject(this.model, id, payload)) throw new errors.InvalidGrant("Connection replaced. Sign in again.")
        if (this.model === "Client" && !store.db.prepare("SELECT id FROM objects WHERE model='Client' AND id=?").get(id)) {
          const count = Number(store.db.prepare("SELECT count(*) AS count FROM objects WHERE model='Client'").get()!.count)
          if (count >= 1000) throw new errors.InvalidClientMetadata("Client registration limit reached.")
        }
        store.db.prepare(`INSERT INTO objects VALUES(?,?,?,?,?,?,?) ON CONFLICT(model,id) DO UPDATE SET
          payload=excluded.payload, expires=excluded.expires, uid=excluded.uid, user_code=excluded.user_code, grant_id=excluded.grant_id`)
          .run(this.model, id, JSON.stringify(payload), expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : null,
            typeof payload.uid === "string" ? payload.uid : null,
            typeof payload.userCode === "string" ? payload.userCode : null,
            typeof payload.grantId === "string" ? payload.grantId : null)
      }
      private lookup(column: "id" | "uid" | "user_code", value: string): AdapterPayload | undefined {
        const row = store.db.prepare(`SELECT payload FROM objects WHERE model=? AND ${column}=? AND (expires IS NULL OR expires>?)`)
          .get(this.model, value, Math.floor(Date.now() / 1000))
        if (!row) return undefined
        const payload = JSON.parse(String(row.payload)) as AdapterPayload
        const id = typeof payload.jti === "string" ? payload.jti : value
        return store.currentObject(this.model, id, payload) ? payload : undefined
      }
      async find(id: string) { return this.lookup("id", id) }
      async findByUid(uid: string) { return this.lookup("uid", uid) }
      async findByUserCode(code: string) { return this.lookup("user_code", code) }
      async destroy(id: string) { store.db.prepare("DELETE FROM objects WHERE model=? AND id=?").run(this.model, id) }
      async revokeByGrantId(id: string) { store.revokeGrant(id) }
      async consume(id: string) {
        const result = store.db.prepare(`UPDATE objects SET payload=json_set(payload,'$.consumed',?)
          WHERE model=? AND id=? AND json_extract(payload,'$.consumed') IS NULL`)
          .run(Math.floor(Date.now() / 1000), this.model, id)
        if (result.changes !== 1) throw new errors.InvalidGrant("Grant already consumed.")
      }
    }
  }
  close() { this.db.close() }
}
