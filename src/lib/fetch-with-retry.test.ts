import { afterEach, describe, it, expect, vi } from "vitest"
import { fetchWithRetry, maskSensitiveUrl } from "./fetch-with-retry.js"

// Critical Rule 11: URL/에러 메시지 외부 노출 전 API 키 마스킹 (회귀 시 키 유출)
describe("maskSensitiveUrl — API 키 마스킹", () => {
  it("법제처 OC 키를 *** 처리 (다른 파라미터는 보존)", () => {
    expect(
      maskSensitiveUrl("http://www.law.go.kr/DRF/lawService.do?OC=mysecret&target=law&MST=160001"),
    ).toBe("http://www.law.go.kr/DRF/lawService.do?OC=***&target=law&MST=160001")
  })
  it("소문자 oc 및 흔한 키 파라미터 이름들도 마스킹", () => {
    expect(maskSensitiveUrl("https://x/?oc=k")).toBe("https://x/?oc=***")
    expect(maskSensitiveUrl("https://x/?apiKey=abc&q=1")).toBe("https://x/?apiKey=***&q=1")
    expect(maskSensitiveUrl("https://x/?auth_key=abc")).toBe("https://x/?auth_key=***")
  })
  it("키가 없으면 원본 그대로", () => {
    expect(maskSensitiveUrl("https://www.law.go.kr/DRF/lawSearch.do?query=민법")).toBe(
      "https://www.law.go.kr/DRF/lawSearch.do?query=민법",
    )
  })
  it("빈 문자열은 안전하게 통과", () => {
    expect(maskSensitiveUrl("")).toBe("")
  })
  it("도구 출력 속 상세링크: 줄 끝에서 멈추고 다음 줄은 보존", () => {
    const text = "  링크: /DRF/lawService.do?OC=srv&amp;target=expc&amp;ID=1\n  링크: /DRF/lawService.do?target=prec&OC=srv2\n다음 줄"
    expect(maskSensitiveUrl(text)).toBe(
      "  링크: /DRF/lawService.do?OC=***&amp;target=expc&amp;ID=1\n  링크: /DRF/lawService.do?target=prec&OC=***\n다음 줄",
    )
  })
  it("HTML 엔티티(&amp;OC=)·URL 인코딩(OC%3D) 형태도 마스킹", () => {
    expect(maskSensitiveUrl("?target=law&amp;OC=srv&amp;MST=1")).toBe("?target=law&amp;OC=***&amp;MST=1")
    expect(maskSensitiveUrl("?url=x%3Fy%26OC%3Dsrv")).toBe("?url=x%3Fy%26OC%3D***")
    expect(maskSensitiveUrl("?serviceKey=abc&numOfRows=10")).toBe("?serviceKey=***&numOfRows=10")
  })
})

// #150-7: Retry-After 값을 그대로 믿으면 업스트림 헤더 하나가 대기를 임의로 늘린다
// (3600 → 1시간 sleep). 상한 30초로 클램프 — 도구 타임아웃(30초)과 같은 자리다.
describe("getRetryDelay — Retry-After 상한", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("비상식적으로 큰 Retry-After도 30초로 클램프한다", async () => {
    vi.useFakeTimers()
    let n = 0
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++
      return n === 1
        ? new Response("busy", { status: 429, headers: { "Retry-After": "3600" } })
        : new Response("<ok/>", { status: 200 })
    }))

    const pending = fetchWithRetry("https://example.com/x", { retryDelay: 1 })
    // 클램프 상한(30초)까지 시계를 돌리면 재시도가 이미 발사됐어야 한다
    await vi.advanceTimersByTimeAsync(30_100)
    expect(n).toBe(2)
    await expect(pending).resolves.toMatchObject({ status: 200 })
  })
})
