import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OAuthStore } from "./oauth-store.js"

describe("employee usage totals", () => {
  it("uses Korean calendar boundaries and keeps removed employees in the denominator", () => {
    const store = new OAuthStore(":memory:", "http://localhost")
    try {
      const before = Date.parse("2026-08-31T14:59:59Z")
      const after = Date.parse("2026-08-31T15:00:00Z")
      store.recordToolCalls("former", 6, before)
      store.recordToolCalls("employee", 3, after)
      store.recordToolCalls("other", 1, after)
      expect(store.usageSummary("today", ["employee", "other"], after).total).toBe(4)
      expect(store.usageSummary("month", ["employee"], after).total).toBe(4)
      const all = store.usageSummary("all", ["employee", "unused"], after)
      expect(all.total).toBe(10)
      expect(all.rows.find(r => r.id === "employee")).toMatchObject({ calls: 3, percent: 30 })
      expect(all.rows.find(r => r.id === "former")).toMatchObject({ calls: 6, percent: 60, registered: false })
      expect(all.rows.find(r => r.id === "unused")).toMatchObject({ calls: 0, percent: 0 })
      expect(store.usageSummary("today", ["employee"], after + 86400000).total).toBe(0)
      expect(store.usageSummary("month", ["employee"], after + 86400000).total).toBe(4)
    } finally { store.close() }
  })
  it("persists aggregates and the collection start across restarts without counting empty requests", () => {
    const directory = mkdtempSync(join(tmpdir(), "law-usage-test-"))
    const path = join(directory, "usage.sqlite")
    let store = new OAuthStore(path, "http://localhost")
    try {
      const startedAt = store.usageSummary("all", []).startedAt
      for (const n of [0, -1, NaN, 0.5]) store.recordToolCalls("employee", n)
      expect(store.usageSummary("all", ["employee"]).rows[0].percent).toBe(0)
      store.recordToolCalls("employee", 2)
      store.recordToolCalls("employee", 1)
      store.manageAccount("admin", "employee", "block")
      store.close()
      store = new OAuthStore(path, "http://localhost")
      expect(store.usageSummary("all", ["employee"])).toMatchObject({ total: 3, startedAt,
        rows: [{ id: "employee", calls: 3, percent: 100 }] })
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
  })
})
