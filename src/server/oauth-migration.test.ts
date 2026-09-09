import { it, expect } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OAuthStore } from "./oauth-store.js"

it("migrates existing law connections and usage without invalidating grants, then preserves per-service usage after restart", async () => {
  const folder = mkdtempSync(join(tmpdir(), "service-migration-")), file = join(folder, "oauth.sqlite")
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE active_connections (account_id TEXT PRIMARY KEY, login_id TEXT NOT NULL, grant_id TEXT);
    INSERT INTO active_connections VALUES('staff','original-login','original-grant');
    CREATE TABLE employee_usage(day TEXT NOT NULL,account_id TEXT NOT NULL,calls INTEGER NOT NULL,PRIMARY KEY(day,account_id));
    INSERT INTO employee_usage VALUES('2026-09-08','staff',4);`)
  db.close()
  let store = new OAuthStore(file, "http://localhost")
  try {
    const Adapter = store.adapter(), grants = new Adapter("Grant")
    await grants.upsert("original-grant", { accountId: "staff", jti: "original-grant" }, 600)
    expect(await grants.find("original-grant")).toBeTruthy()
    store.recordToolCalls("staff", 2, Date.now(), "g2b")
    const login = store.beginLogin("staff", "", "g2b"); store.activateGrant("staff", login, "g2b-grant", "g2b")
    expect(await grants.find("original-grant")).toBeTruthy()
    expect(store.usageSummary("all", ["staff"], Date.now(), "law").total).toBe(4)
    expect(store.usageSummary("all", ["staff"]).total).toBe(6)
    store.setServices("admin", "staff", ["law", "g2b"])
    store.close(); store = new OAuthStore(file, "http://localhost")
    expect(store.isCurrentLogin("staff", "original-login", "law")).toBe(true)
    expect(store.isCurrentLogin("staff", login, "g2b")).toBe(true)
    expect(store.canUse("staff", "kosis")).toBe(false)
    expect(store.usageSummary("all", ["staff"]).total).toBe(6)
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }) }
})
