import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseDateRange } from "./date-parser.js"
import { routeQuery } from "./query-router.js"
import { applyDateRange } from "./cli-executor.js"

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }))
afterEach(() => vi.useRealTimers())

describe("relative month ranges at month end", () => {
  it.each([
    ["2000-03-30", "지난달", "20000201", "20000229"],
    ["2000-03-30", "저번달", "20000201", "20000229"],
    ["2025-03-31", "지난달", "20250201", "20250228"],
    ["2025-05-31", "지난달", "20250401", "20250430"],
    ["2025-01-31", "지난달", "20241201", "20241231"],
    ["2025-03-15", "지난달", "20250201", "20250228"],
    ["2000-01-31", "38개월 전", "19961101", "19961130"],
    ["2025-03-31", "1개월 전", "20250201", "20250228"],
    ["2025-01-31", "0개월 전", "20250101", "20250131"],
    ["2025-01-31", "이번달", "20250101", "20250131"],
  ])("%s: %s selects the requested month", (today, phrase, from, to) => {
    vi.setSystemTime(new Date(`${today}T12:00:00`))
    expect(parseDateRange(`${phrase} 음주운전 판례`)).toEqual({
      range: { from, to }, matched: phrase,
    })
  })

  it.each([
    ["2000-01-31", "최근 38개월", "19961130", "20000131"],
    ["2025-03-31", "최근 1개월", "20250228", "20250331"],
    ["2024-03-31", "최근 1개월", "20240229", "20240331"],
    ["2025-05-31", "최근 1개월", "20250430", "20250531"],
    ["2025-01-31", "최근 1개월", "20241231", "20250131"],
    ["2025-03-15", "최근 1개월", "20250215", "20250315"],
    ["2025-01-31", "최근 0개월", "20250131", "20250131"],
  ])("%s: %s clamps only days absent in the target month", (today, phrase, from, to) => {
    vi.setSystemTime(new Date(`${today}T12:00:00`))
    expect(parseDateRange(`${phrase} 음주운전 판례`)).toEqual({
      range: { from, to }, matched: phrase,
    })
  })

  it("passes the previous calendar month into CLI search filters", () => {
    vi.setSystemTime(new Date("2025-03-31T12:00:00"))
    const route = routeQuery("지난달 음주운전 판례")
    applyDateRange(route)
    expect(route.tool).toBe("search_precedents")
    expect(route.params).toMatchObject({
      query: "음주운전", fromDate: "20250201", toDate: "20250228",
    })
  })
})
