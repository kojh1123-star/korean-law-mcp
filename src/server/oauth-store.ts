import { DatabaseSync } from "node:sqlite"
import { mkdirSync, chmodSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { generateKeyPairSync, randomBytes } from "node:crypto"
import { errors, type AdapterPayload, type AdapterConstructor } from "oidc-provider"

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
    `)
    const savedIssuer = this.setting("issuer", () => issuer)
    if (savedIssuer !== issuer) { this.close(); throw new Error("OAuth database issuer differs from OAUTH_ISSUER. Use the original issuer or a new volume.") }
  }
  /** A successful password check replaces the account's connection atomically. */
  beginLogin(accountId: string, interactionId = ""): string {
    const loginId = randomBytes(32).toString("hex")
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.prepare(`INSERT INTO active_connections VALUES(?,?,NULL)
        ON CONFLICT(account_id) DO UPDATE SET login_id=excluded.login_id, grant_id=NULL`).run(accountId, loginId)
      const grants = this.db.prepare("SELECT id FROM objects WHERE model='Grant' AND json_extract(payload,'$.accountId')=?").all(accountId)
      for (const grant of grants) this.revokeGrant(String(grant.id), interactionId)
      this.db.prepare("DELETE FROM objects WHERE model IN ('AccessToken','RefreshToken','AuthorizationCode') AND json_extract(payload,'$.accountId')=?").run(accountId)
      this.db.exec("COMMIT")
      return loginId
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
  }
  isCurrentLogin(accountId: string, loginId: unknown): boolean {
    return typeof loginId === "string" && !!this.db.prepare("SELECT 1 FROM active_connections WHERE account_id=? AND login_id=?").get(accountId, loginId)
  }
  activateGrant(accountId: string, loginId: unknown, grantId: string) {
    if (typeof loginId !== "string" || this.db.prepare(`UPDATE active_connections SET grant_id=?
      WHERE account_id=? AND login_id=? AND (grant_id IS NULL OR grant_id=?)`).run(grantId, accountId, loginId, grantId).changes !== 1) {
      throw new errors.InvalidGrant("This login was replaced. Start a new login.")
    }
  }
  private currentObject(model: string, id: string, payload: AdapterPayload): boolean {
    if (!["Grant", "AccessToken", "RefreshToken", "AuthorizationCode"].includes(model)) return true
    const grantId = model === "Grant" ? id : payload.grantId
    if (typeof payload.accountId !== "string" || typeof grantId !== "string") return false
    return !!this.db.prepare("SELECT 1 FROM active_connections WHERE account_id=? AND grant_id=?").get(payload.accountId, grantId)
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
