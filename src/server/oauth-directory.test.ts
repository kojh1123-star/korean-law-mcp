import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OAuthStore } from "./oauth-store.js"
import { hashPassword, verifyPassword } from "./oauth-accounts.js"

describe("managed employee directory", () => {
  it("keeps added accounts and env-account removals after restarting with the original environment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "law-directory-test-"))
    const path = join(directory, "oauth.sqlite")
    const hash = await hashPassword("test-only-employee-password")
    const bootstrap = new Map(["admin", "env_employee"].map(id => [id, { id, passwordHash: hash }]))
    let store = new OAuthStore(path, "http://localhost")
    try {
      expect(store.loadEmployees(bootstrap).size).toBe(2)
      store.addEmployee("admin", { id: "added_employee", passwordHash: hash })
      store.recordToolCalls("env_employee", 5)
      store.manageAccount("admin", "env_employee", "remove")
      store.close()
      store = new OAuthStore(path, "http://localhost")
      const restored = store.loadEmployees(bootstrap)
      expect([...restored.keys()].sort()).toEqual(["added_employee", "admin"])
      expect(await verifyPassword("test-only-employee-password", restored.get("added_employee")!.passwordHash)).toBe(true)
      expect(store.isBlocked("env_employee")).toBe(true)
      expect(() => store.beginLogin("env_employee")).toThrow()
      expect(store.wasManaged("env_employee")).toBe(true)
      expect(() => store.addEmployee("admin", { id: "env_employee", passwordHash: hash })).toThrow()
      expect(store.usageSummary("all", [...restored.keys()]).rows.find(r => r.id === "env_employee")).toMatchObject({ calls: 5, registered: false })
      expect(store.auditLog().map(r => r.action)).toEqual(["remove", "create"])
      expect(bootstrap.has("env_employee")).toBe(true)
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
  })
})
