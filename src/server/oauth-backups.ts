import { mkdir, readdir, readFile, writeFile, rename, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { z } from "zod"
import { readEmployees, type Employee } from "./oauth-accounts.js"
import { OAuthStore } from "./oauth-store.js"

const id = z.string().regex(/^[a-zA-Z0-9._-]{3,64}$/)
const hash = z.string().regex(/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const rows = <T extends z.ZodType>(schema: T) => z.array(schema).max(100000)
const snapshotSchema = z.object({ version: z.literal(1), issuer: z.string(), createdAt: integer, usageStartedAt: integer,
  employees: z.array(z.object({ id, passwordHash: hash }).strict()).min(1).max(1000),
  tables: z.object({
    managed_employees: rows(z.object({ id, password_hash: hash.nullable(), removed: z.union([z.literal(0), z.literal(1)]) }).strict()),
    account_renames: rows(z.object({ old_id: id, new_id: id }).strict()),
    account_controls: rows(z.object({ account_id: id, blocked: z.union([z.literal(0), z.literal(1)]), last_login: integer.nullable(), last_request: integer.nullable() }).strict()),
    admin_audit: rows(z.object({ id: integer, at: integer, actor: z.string().max(64), target: z.string().max(64), action: z.string().max(64) }).strict()),
    employee_usage: rows(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), account_id: id, service: z.enum(["law", "g2b", "kosis"]).default("law"), calls: integer }).strict()),
    service_permissions: rows(z.object({ account_id: id, service: z.enum(["law", "g2b", "kosis"]), allowed: z.union([z.literal(0), z.literal(1)]) }).strict()).default([]),
    service_metrics: rows(z.object({ service: z.enum(["law", "g2b", "kosis"]), requests: integer, errors: integer, last_success: integer.nullable(), last_error: integer.nullable() }).strict()).default([]),
  }).strict(),
}).strict()

export class AccountBackups {
  readonly folder: string
  private pending: Promise<string> | undefined
  constructor(private store: OAuthStore, private issuer: string, databasePath: string, private employees: Map<string, Employee>) {
    this.folder = join(dirname(databasePath), "backups")
  }
  async list(): Promise<string[]> {
    await mkdir(this.folder, { recursive: true, mode: 0o700 })
    return (await readdir(this.folder)).filter(name => /^accounts-\d{13}-[a-f0-9]{12}\.json$/.test(name)).sort().reverse()
  }
  async create(): Promise<string> {
    if (this.pending) return this.pending
    this.pending = this.write()
    try { return await this.pending } finally { this.pending = undefined }
  }
  private async write() {
    await this.list()
    const name = `accounts-${Date.now()}-${randomBytes(6).toString("hex")}.json`
    const snapshot = { version: 1, issuer: this.issuer, createdAt: Date.now(), employees: [...this.employees.values()], ...this.store.exportOperational() }
    const contents = Buffer.from(JSON.stringify(snapshot))
    this.validate(contents)
    const temporary = join(this.folder, name + ".tmp")
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" })
    await rename(temporary, join(this.folder, name))
    for (const expired of (await this.list()).slice(7)) await unlink(join(this.folder, expired))
    return name
  }
  async daily() {
    const recent = (await this.list())[0]
    if (!recent || Date.now() - Number(recent.split("-")[1]) >= 86400000) await this.create()
  }
  async read(name: string): Promise<Buffer> {
    if (!(await this.list()).includes(name)) throw new Error("Unknown backup.")
    return readFile(join(this.folder, name))
  }
  validate(contents: Buffer) {
    if (contents.length > 5 * 1024 * 1024) throw new Error("Backup exceeds 5 MB.")
    const parsed = snapshotSchema.parse(JSON.parse(contents.toString("utf8")))
    if (parsed.issuer !== this.issuer) throw new Error("Backup belongs to a different server.")
    const accounts = readEmployees(JSON.stringify(parsed.employees))
    for (const row of parsed.tables.managed_employees) {
      if (row.removed === 0 && accounts.get(row.id)?.passwordHash !== row.password_hash) throw new Error("Inconsistent employee snapshot.")
      if (row.removed === 1 && accounts.has(row.id)) throw new Error("Removed employee is active in snapshot.")
    }
    const aliases = new Map(parsed.tables.account_renames.map(row => [row.old_id, row.new_id]))
    for (const start of aliases.keys()) {
      let target = start; const seen = new Set<string>()
      while (aliases.has(target)) {
        if (seen.has(target)) throw new Error("Invalid rename chain in backup.")
        seen.add(target); target = aliases.get(target)!
      }
      if (!accounts.has(target)) throw new Error("Renamed account is missing from backup.")
    }
    return { ...parsed, accounts }
  }
}
