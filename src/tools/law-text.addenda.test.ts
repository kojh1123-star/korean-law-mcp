import { beforeEach, describe, expect, it, vi } from "vitest"
import { getLawText } from "./law-text.js"
import { lawCache } from "../lib/cache.js"
import type { LawApiClient } from "../lib/api-client.js"

const article = (n: number) => ({ 조문여부: "조문", 조문번호: String(n), 조문가지번호: "0", 조문내용: `제${n}조 본문` })
const addendum = (no: string, ymd: string, lines: string[]) => ({ 부칙공포일자: ymd, 부칙공포번호: no, 부칙내용: [[`부칙 <제${Number(no)}호,${ymd}>`, ...lines]] })
const law = (articles: number, units: unknown) => JSON.stringify({ 법령: {
  기본정보: { 법령명_한글: "대한민국헌법", 공포일자: "19871029", 시행일자: "19880225" },
  조문: { 조문단위: Array.from({ length: articles }, (_, i) => article(i + 1)) },
  부칙: { 부칙단위: units },
} })

describe("get_law_text 부칙", () => {
  beforeEach(() => lawCache.clear())

  it('jo="부칙" 은 전문을 받아 부칙 원문을 낸다 (단일 부칙단위 객체)', async () => {
    const stub = vi.fn(async (_input: { jo?: string }) => law(130, addendum("00010", "19871029", ["제1조 이 헌법은 1988년 2월 25일부터 시행한다.", "제6조 이 헌법시행 당시에 …"])))
    const r = await getLawText({ getLawText: stub } as unknown as LawApiClient, { mst: "61603", jo: "부칙" })
    expect(r.isError).toBeFalsy()
    expect(stub.mock.calls[0]?.[0].jo).toBeUndefined()
    const text = r.content[0].text
    expect(text).toContain("부칙 <제10호, 1987.10.29>")
    expect(text).toContain("제1조 이 헌법은 1988년 2월 25일부터 시행한다.")
    expect(text).toContain("제6조 이 헌법시행 당시에")
    expect(text).not.toContain("제1조 본문")
  })

  it("부칙이 여럿이면 최근 공포부터 낸다", async () => {
    const units = [addendum("00001", "19900101", ["제1조 옛 부칙"]), addendum("00020", "20200101", ["제1조 새 부칙"])]
    const r = await getLawText({ getLawText: async () => law(3, units) } as unknown as LawApiClient, { mst: "m", jo: "부칙" })
    const text = r.content[0].text
    expect(text.indexOf("새 부칙")).toBeLessThan(text.indexOf("옛 부칙"))
    expect(text).toContain("부칙 2건")
  })

  it("목차와 전문 끝에 부칙 조회 안내를 붙인다", async () => {
    const big = await getLawText({ getLawText: async () => law(130, addendum("00010", "19871029", ["제1조 시행일"])) } as unknown as LawApiClient, { mst: "61603" })
    expect(big.content[0].text).toContain('부칙 1건: get_law_text(mst="61603", jo="부칙")')
    lawCache.clear()
    const small = await getLawText({ getLawText: async () => law(3, addendum("00010", "19871029", ["제1조 시행일"])) } as unknown as LawApiClient, { mst: "s" })
    expect(small.content[0].text).toContain('부칙 1건: get_law_text(mst="s", jo="부칙")')
  })

  it("부칙이 없으면 NOT_FOUND 로 알린다", async () => {
    const r = await getLawText({ getLawText: async () => law(3, undefined) } as unknown as LawApiClient, { mst: "m", jo: "부칙" })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("[NOT_FOUND]")
  })
})
