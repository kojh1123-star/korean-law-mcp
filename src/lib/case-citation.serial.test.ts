import { afterEach, describe, expect, it, vi } from "vitest"
import type { LawApiClient } from "./api-client.js"
import { COURT_CASE_PATTERN, extractCaseNumbers, verifyCaseCitations } from "./case-citation.js"
import { routeQuery } from "./query-router.js"

afterEach(() => vi.useRealTimers())

describe("case serial width agrees across parsing consumers", () => {
  // Synthetic parser-boundary cases; these tests do not assert that a case exists.
  it.each(["1900다10000000", "2023개회99999999", "96누10000000"])(
    "extracts the complete eight-digit serial: %s", caseNo => {
      expect(extractCaseNumbers(`대법원 ${caseNo} 판결 참조.`)).toEqual([caseNo])
      expect(extractCaseNumbers(caseNo.replace(/(\d)([가-힣]+)(\d)/, "$1 \t $2\n$3"))).toEqual([caseNo])
    },
  )

  it("extracts the same number that the router and query planner recognize", () => {
    const caseNo = "2023개회10000000"
    const route = routeQuery(`${caseNo} 아직 유효해?`)
    expect(route.tool).toBe("cite_check")
    expect(route.params.caseNumber).toBe(caseNo)
    expect(new RegExp(COURT_CASE_PATTERN).exec(caseNo)?.[0]).toBe(caseNo)
    expect(extractCaseNumbers(route.params.caseNumber as string)).toEqual([caseNo])
  })

  it("keeps oversized serials and quantity prose out without extracting a prefix", () => {
    for (const text of ["2023다100000000", "2023 다 100000000", "2030도10000000명", "2030 도 10000000 명이 증가했다"]) {
      expect(extractCaseNumbers(text)).toEqual([])
    }
  })

  it("does not route or classify an oversized serial as an eight-digit prefix", () => {
    const caseNo = "1900다100000000"
    expect(new RegExp(COURT_CASE_PATTERN).test(caseNo)).toBe(false)
    expect(routeQuery(`${caseNo} 아직 유효해?`).tool).not.toBe("cite_check")
  })

  it("does not silently omit an eight-digit serial from citation verification", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-11T12:00:00"))
    const fetchApi = vi.fn()
    const report = await verifyCaseCitations({ fetchApi } as unknown as LawApiClient, "2099다10000000 판결 참조.")
    expect(report.total).toBe(1)
    expect(report.fail).toBe(1)
    expect(report.lines[0]).toContain("2099다10000000")
    expect(fetchApi).not.toHaveBeenCalled()
  })
})
