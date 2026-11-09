/**
 * 노동 행정 도메인 3종 — 고용노동부 법령해석(moelCgmExpc), 산재보험재심사위원회(iaciac), 고용보험심사위원회(eiac)
 *
 * 픽스처는 2026-10-14 법제처 OPEN API 실응답을 줄인 것이다(본문 일부 생략, 구조·태그는 원형 유지).
 */
import { describe, expect, it, vi } from "vitest"
import { searchDecisions, getDecisionText } from "./unified-decisions.js"
import { cleanReviewCommitteeText } from "./committee-decisions.js"
import { routeQuery } from "../lib/query-router.js"
import type { LawApiClient } from "../lib/api-client.js"

const MOEL_LIST_XML = `<?xml version="1.0" encoding="UTF-8"?><CgmExpc><target>moelCgmExpc</target><키워드>통상임금</키워드><section>itmNm</section><totalCnt>66</totalCnt><page>1</page><numOfRows>2</numOfRows><resultCode>00</resultCode><resultMsg>success</resultMsg><cgmExpc id="1"><법령해석일련번호>16684</법령해석일련번호><안건명><![CDATA[5인 미만 사업장의 통상임금 산정을 위한 소정근로시간 수]]></안건명><안건번호><![CDATA[근로기준정책과-2668]]></안건번호><질의기관명></질의기관명><질의기관코드></질의기관코드><해석기관명>고용노동부</해석기관명><해석기관코드>1492000</해석기관코드><해석일자>2022.08.26</해석일자><법령해석상세링크>/DRF/lawService.do?OC=test&amp;target=moelCgmExpc&amp;ID=16684&amp;type=HTML&amp;mobileYn=</법령해석상세링크><데이터기준일시>2024.12.16</데이터기준일시></cgmExpc><cgmExpc id="2"><법령해석일련번호>22798</법령해석일련번호><안건명><![CDATA[각종수당의 통상임금 포함 여부]]></안건명><안건번호><![CDATA[임금근로시간정책팀-1343]]></안건번호><질의기관명></질의기관명><질의기관코드></질의기관코드><해석기관명>고용노동부</해석기관명><해석기관코드>1492000</해석기관코드><해석일자>2007.04.09</해석일자><법령해석상세링크>/DRF/lawService.do?OC=test&amp;target=moelCgmExpc&amp;ID=22798&amp;type=HTML&amp;mobileYn=</법령해석상세링크><데이터기준일시>2024.12.16</데이터기준일시></cgmExpc></CgmExpc>`

const MOEL_DETAIL = {
  CgmExpcService: {
    안건명: "5인 미만 사업장의 통상임금 산정을 위한 소정근로시간 수",
    질의요지: "5인 미만 사업장에서 주5일(1일 근무시간 10시간) 총 50시간을 근로하는 근로자의 일급 통상임금을 계산할 때 소정근로시간 수를 어떻게 산정해야 하는지",
    해석기관코드: "1492000",
    안건번호: "근로기준정책과-2668",
    이유: "",
    법령해석일련번호: "16684",
    질의기관명: "",
    관련법령: "",
    해석기관명: "고용노동부",
    해석일자: "20220826",
    회답: "「근로기준법」 제2조제1항제8호에 따라 “소정근로시간”이란 … 일급 통상임금을 산정하기위해서는 8시간을 곱하여 산정 하여야 할 것으로 사료됨(근로기준정책과-3590, 2020.9.4.).",
    등록일시: "20250119",
  },
}

const IACIAC_LIST_XML = `<?xml version="1.0" encoding="UTF-8"?><Iaciac><target>iaciac</target><키워드>*</키워드><section>evtNm</section><totalCnt>934</totalCnt><page>1</page><기관명>산업재해보상보험재심사위원회</기관명><iaciac id="1"><결정문일련번호>12699</결정문일련번호><사건><![CDATA[2010재결 제2071호 요양불승인처분취소]]></사건><사건번호>2010-2071호</사건번호><의결일자>2010.08.27</의결일자><결정문상세링크>/DRF/lawService.do?OC=test&amp;target=iaciac&amp;ID=12699&amp;type=HTML&amp;mobileYn=</결정문상세링크></iaciac></Iaciac>`

const IACIAC_DETAIL = {
  IaciacService: {
    청구취지: "원처분기관이 2009. 11. 16. 청구인에게 행한 요양불승인처분을 취소한다는 재결을구하는데 있다.",
    사건: "2010재결 제2071호 요양불승인처분취소",
    사건대분류: "업무상 재해 여부 관련",
    이유: "1.  사건개요청구인은 … 6. 결 론그러므로 이 사건 요양불승인처분이 부당함을 전제로 그 취소를 구하는 청구인의 재심사청구는 이유 없다.",
    결정문일련번호: "12699",
    쟁점: "금형 작업 중 약품이 눈에 들어간 사고와 상병 사이의 상당인과관계를 부정한 사례",
    의결일자: "2010.8.27",
    원처분기관: "근로복지공단 서울서부지사장",
    주문: "청구인의 재심사청구를 기각한다.",
    사건번호: "2010-2071호",
    사건중분류: "업무상 사고",
    사건소분류: "작업시간 중 사고",
  },
}

const EIAC_DETAIL = {
  EiacService: {
    각주목록: {
      각주번호: ["1", "2"],
      각주내용: [
        "청구인의 소정급여 일수는 210일, 수급기간은 2019. 4. 1.부터 2019. 11. 10.까지이다.",
        "청구인이 언급하는 직장동료 이○○은 … 1일 소정근로시간을 8시간으로 결정하였다.",
      ],
    },
    청구취지: "주문과 같다.<span style=\"display:none;\">○ 사건번호 및 사건명2019재결 제117호 … ○ 청구취지주문과 같다.</span>",
    사건의분류: "수급자격에 관한 사례",
    결정문일련번호: "11327",
    이유: "1. 사건개요가. … 구직급여 일액을 52,605원(8,350원×7시간×0.9)으로 결정하는 이 사건 처분을 하였다.<각주>1</각주>나. 근로계약서 발췌<img src=\"http://www.law.go.kr/flDownload.do?flSeq=134788289\" alt=\"1번째 이미지\"></img>7. 결론그렇다면 청구인의 청구가 이유 있다.",
    청구인: "전 ○ ○",
    피청구인: "○○지방고용노동청장",
    의결서종류: "재결서",
    의결일자: "2019.10.23",
    사건명: "고용보험 구직급여일액 결정 처분 변경 청구",
    주문: "피청구인이 2019. 4. 11. 청구인에게 행한 실업급여 수급자격 인정 처분 중 청구인의 1일 소정근로시간을 8시간으로 하여 구직급여일액을 산정하라.",
    개요: "3조2교대 근무로 인해 1주의 근로제공일이 5일에 미달된다고 하더라도, 일단위로 소정근로시간이 정해졌다고 본 사례",
    사건번호: "2019재결 제117호",
    기관명: "고용보험심사위원회",
  },
}

function apiReturning(body: string) {
  const fetchApi = vi.fn(async () => body)
  return { api: { fetchApi } as unknown as LawApiClient, fetchApi }
}

describe("moel: 고용노동부 법령해석(질의회시)", () => {
  it("search routes to target moelCgmExpc, forwards body search scope, and lists 안건번호", async () => {
    const { api, fetchApi } = apiReturning(MOEL_LIST_XML)
    const result = await searchDecisions(api, { domain: "moel", query: "통상임금", options: { search: "2" } })
    expect(result.isError).not.toBe(true)
    expect(fetchApi.mock.calls[0]?.[0]).toMatchObject({
      endpoint: "lawSearch.do",
      target: "moelCgmExpc",
      extraParams: { query: "통상임금", search: "2" },
    })
    const text = result.content[0].text
    expect(text).toContain("고용노동부 법령해석 검색 결과 (총 66건")
    expect(text).toContain("[16684] 5인 미만 사업장의 통상임금 산정을 위한 소정근로시간 수")
    expect(text).toContain("안건번호: 근로기준정책과-2668")
  })

  it("ignores an invalid search scope instead of forwarding it", async () => {
    const { api, fetchApi } = apiReturning(MOEL_LIST_XML)
    await searchDecisions(api, { domain: "moel", query: "통상임금", options: { search: "both" } })
    expect((fetchApi.mock.calls[0]?.[0] as { extraParams: Record<string, string> }).extraParams.search).toBeUndefined()
  })

  it("detail renders 안건번호·질의요지·회답 without compaction", async () => {
    const { api, fetchApi } = apiReturning(JSON.stringify(MOEL_DETAIL))
    const result = await getDecisionText(api, { domain: "moel", id: "16684" })
    expect(fetchApi.mock.calls[0]?.[0]).toMatchObject({ endpoint: "lawService.do", target: "moelCgmExpc", extraParams: { ID: "16684" } })
    const text = result.content[0].text
    expect(text).toContain("=== 5인 미만 사업장의 통상임금 산정을 위한 소정근로시간 수 ===")
    expect(text).toContain("안건번호: 근로기준정책과-2668")
    expect(text).toContain("질의요지:")
    expect(text).toContain("8시간을 곱하여 산정 하여야 할 것으로 사료됨(근로기준정책과-3590, 2020.9.4.)")
  })
})

describe("iaciac: 산업재해보상보험재심사위원회 결정문", () => {
  it("search reads the <사건> title tag", async () => {
    const { api, fetchApi } = apiReturning(IACIAC_LIST_XML)
    const result = await searchDecisions(api, { domain: "iaciac", query: "요양불승인" })
    expect(fetchApi.mock.calls[0]?.[0]).toMatchObject({ target: "iaciac" })
    const text = result.content[0].text
    expect(text).toContain("산업재해보상보험재심사위원회 결정문 검색 결과 (총 934건")
    expect(text).toContain("[12699] 2010재결 제2071호 요양불승인처분취소")
    expect(text).toContain("사건번호: 2010-2071호")
    expect(text).toContain("결정일: 2010.08.27")
    expect(text).not.toContain("(제목 없음)")
  })

  it("detail renders 분류·원처분기관·쟁점·청구취지 and the decision", async () => {
    const { api } = apiReturning(JSON.stringify(IACIAC_DETAIL))
    const text = (await getDecisionText(api, { domain: "iaciac", id: "12699", full: true })).content[0].text
    expect(text).toContain("=== 2010재결 제2071호 요양불승인처분취소 ===")
    expect(text).toContain("사건분류: 업무상 재해 여부 관련 > 업무상 사고 > 작업시간 중 사고")
    expect(text).toContain("원처분기관: 근로복지공단 서울서부지사장")
    expect(text).toContain("주문:\n청구인의 재심사청구를 기각한다.")
    expect(text).toContain("쟁점:\n금형 작업 중")
    expect(text).toContain("청구취지:\n원처분기관이")
    expect(text).toContain("재심사청구는 이유 없다.")
  })
})

describe("eiac: 고용보험심사위원회 결정문", () => {
  it("detail drops the hidden summary span, marks footnotes/images, and renders 각주목록", async () => {
    const { api, fetchApi } = apiReturning(JSON.stringify(EIAC_DETAIL))
    const text = (await getDecisionText(api, { domain: "eiac", id: "11327", full: true })).content[0].text
    expect(fetchApi.mock.calls[0]?.[0]).toMatchObject({ target: "eiac" })
    expect(text).toContain("=== 고용보험 구직급여일액 결정 처분 변경 청구 ===")
    expect(text).toContain("결정유형: 재결서")
    expect(text).toContain("사건분류: 수급자격에 관한 사례")
    expect(text).toContain("피청구인: ○○지방고용노동청장")
    expect(text).toContain("청구취지:\n주문과 같다.\n")
    expect(text).not.toContain("display:none")
    expect(text).not.toContain("<span")
    expect(text).toContain("처분을 하였다.[각주1]")
    expect(text).toContain("[이미지]")
    expect(text).not.toContain("<img")
    expect(text).toContain("각주:\n[1] 청구인의 소정급여 일수는 210일")
    expect(text).toContain("[2] 청구인이 언급하는 직장동료")
    expect(text).not.toContain("[object Object]")
  })

  it("cleanReviewCommitteeText leaves plain text untouched", () => {
    expect(cleanReviewCommitteeText("주문과 같다.")).toBe("주문과 같다.")
    expect(cleanReviewCommitteeText("")).toBe("")
  })
})

describe("routing: 노동 행정 도메인", () => {
  it.each([
    ["고용노동부 행정해석 통상임금", "moel", "통상임금"],
    ["노동부 질의회시 연차휴가", "moel", "연차휴가"],
    ["산재 재심사 뇌출혈", "iaciac", "뇌출혈"],
    ["고용보험 재심사 구직급여", "eiac", "구직급여"],
  ])("%s → search_decisions(domain=%s)", (query, domain, keyword) => {
    const r = routeQuery(query)
    expect(r.tool).toBe("search_decisions")
    expect(r.params).toMatchObject({ domain, query: keyword })
  })

  it("plain 해석례 queries keep going to 법제처 해석례", () => {
    expect(routeQuery("통상임금 해석례").tool).toBe("search_interpretations")
  })
})
