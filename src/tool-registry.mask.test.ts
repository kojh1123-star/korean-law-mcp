import { describe, it, expect } from "vitest"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { LawApiClient } from "./lib/api-client.js"
import { registerTools } from "./tool-registry.js"

// Critical Rule 11: 법제처 검색 응답의 상세링크는 요청에 쓴 OC 키를 그대로 담아 온다.
// 최종 출력 게이트가 가리지 않으면 서버 폴백 키가 모든 호출자에게 노출된다.
const SECRET = "server-fallback-oc-value"
const XML = `<?xml version="1.0" encoding="UTF-8"?><Expc><totalCnt>1</totalCnt><page>1</page><expc id="1">` +
  `<법령해석례일련번호>1</법령해석례일련번호><안건명>테스트 안건</안건명><안건번호>24-0001</안건번호>` +
  `<질의기관명>A</질의기관명><회신기관명>B</회신기관명><회신일자>20240101</회신일자>` +
  `<법령해석례상세링크>/DRF/lawService.do?OC=${SECRET}&amp;target=expc&amp;ID=1&amp;type=HTML</법령해석례상세링크>` +
  `</expc></Expc>`

async function connect(fetchApi: () => Promise<string>) {
  const server = new Server({ name: "mask-test", version: "1" }, { capabilities: { tools: {} } })
  registerTools(server, { fetchApi } as unknown as LawApiClient)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "mask-test-client", version: "1" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as Array<{ text: string }>).map(c => c.text).join("\n")

describe("tool output gate — OC key masking", () => {
  it("masks the OC key in upstream detail links while keeping the rest of the link", async () => {
    const client = await connect(async () => XML)
    const text = textOf(await client.callTool({ name: "search_interpretations", arguments: { query: "테스트" } }))
    expect(text).toContain("테스트 안건")
    expect(text).toContain("OC=***&amp;target=expc")
    expect(text).not.toContain(SECRET)
  })

  it("masks the OC key in error output as well", async () => {
    const client = await connect(async () => {
      throw new Error(`upstream failed for /DRF/lawSearch.do?OC=${SECRET}&target=expc`)
    })
    const result = await client.callTool({ name: "search_interpretations", arguments: { query: "테스트" } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).not.toContain(SECRET)
  })
})
