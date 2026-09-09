import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { tools, callTool, serverInstructions, exportContext } from "./client.mjs"
import { runWithRequestContext } from "../../lib/session-state.js"

export function createKosisServer(save?: (bytes: Buffer, filename: string) => unknown) {
  const server = new Server({ name: "kosis-web", version: "2.0.0" }, { capabilities: { tools: {} }, instructions: serverInstructions })
  const validators = new Map(tools.map(tool => [tool.name, z.fromJSONSchema(tool.inputSchema as any)]))
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools as any }))
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const sanitize = (s: string) => {
      const key = process.env.KOSIS_TOKEN || ""
      if (key) for (const value of [key, encodeURIComponent(key)]) s = s.split(value).join("[REDACTED]")
      return s.replace(/(apiKey|serviceKey)(=|%3D)[^&\s"<>]+/gi, "$1$2[REDACTED]")
    }
    try {
      const validator = validators.get(req.params.name)
      if (!validator) throw new Error("지원하지 않는 KOSIS 도구입니다.")
      if (req.params.name === "kosis_export_excel" && !save) throw new Error("엑셀 다운로드는 직원 OAuth 로그인이 필요합니다.")
      const args = validator.parse(req.params.arguments || {})
      const result = await runWithRequestContext({ signal: AbortSignal.any([extra.signal, AbortSignal.timeout(120000)]) }, () => exportContext.run(save, () => callTool(req.params.name, args)))
      const text = sanitize(JSON.stringify(result))
      return { content: [{ type: "text", text }], structuredContent: JSON.parse(text), isError: false }
    } catch (error) {
      return { content: [{ type: "text", text: sanitize(error instanceof Error ? error.message : "KOSIS 요청을 처리할 수 없습니다.") }], isError: true }
    }
  })
  return server
}
