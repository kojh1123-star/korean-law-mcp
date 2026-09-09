import { it, expect } from "vitest"
import express from "express"
import { hashPassword } from "./oauth-accounts.js"
import { OAuthStore } from "./oauth-store.js"
import { installEmployeeDownloads } from "./employee-downloads.js"

it("protects files by account, rejects forged requests, and revokes downloads with credentials or service access", async () => {
  const store = new OAuthStore(":memory:", "http://localhost")
  const password = "download-test-only-password"
  const employee = { id: "staff01", passwordHash: await hashPassword(password) }
  const employees = new Map([employee, { ...employee, id: "staff02" }].map(e => [e.id, e]))
  const app = express(), server = app.listen(0, "127.0.0.1")
  await new Promise<void>(resolve => server.once("listening", resolve))
  const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const downloads = installEmployeeDownloads(app, { issuer, local: true, store, employees, secret: "fixture-only-secret", dummyHash: employee.passwordHash })
  let cookies = new Map<string, string>()
  const file = downloads.save(employee.id, Buffer.from("fixture workbook"), "통계.xlsx")
  const request = async (options: RequestInit = {}) => {
    const res = await fetch(file.download_url, { ...options, headers: { ...options.headers, cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") }, redirect: "manual" })
    for (const value of res.headers.getSetCookie()) { const pair = value.split(";")[0], i = pair.indexOf("="); cookies.set(pair.slice(0, i), pair.slice(i + 1)) }
    return res
  }
  const login = async (id: string, forge = false) => {
    cookies = new Map()
    const page = await (await request()).text()
    expect(page).toContain("로그인해주세요")
    const csrf = page.match(/name="csrf" value="([^"]+)"/)![1]
    return request({ method: "POST", headers: { origin: issuer, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: forge ? "0".repeat(64) : csrf, username: id, password }) })
  }
  try {
    expect((await login("staff01", true)).status).toBe(403)
    expect((await login("staff02")).status).toBe(303)
    expect((await request()).status).toBe(404)
    expect((await login("staff01")).status).toBe(303)
    const response = await request()
    expect(response.headers.get("content-disposition")).toContain("attachment")
    expect(await response.text()).toBe("fixture workbook")
    store.setServices("admin", employee.id, ["law"])
    expect(await (await request()).text()).toContain("로그인해주세요")
    store.setServices("admin", employee.id, ["kosis"])
    employees.set(employee.id, { ...employee, passwordHash: await hashPassword("changed-test-password") })
    expect(await (await request()).text()).toContain("로그인해주세요")
    expect(() => downloads.save("missing", Buffer.from("x"), "x.xlsx")).toThrow()
    expect(() => downloads.save("staff02", Buffer.alloc(5 * 1024 * 1024 + 1), "x.xlsx")).toThrow()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    downloads.close(); store.close()
  }
})
