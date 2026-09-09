import { it, expect, vi } from "vitest"
import ExcelJS from "exceljs"
import { callTool, exportContext } from "./client.mjs"

it("exports real XLSX bytes with source metadata and never treats cells as formulas or leaks the key", async () => {
  vi.stubEnv("KOSIS_TOKEN", "fixture-secret-token")
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ 항목: "=1+1", 값: 12.5 }]), { headers: { "content-type": "application/json" } })))
  try {
    let bytes: Buffer | undefined
    await exportContext.run((buffer: Buffer) => { bytes = buffer; return { download_url: "https://example.org/downloads/test" } }, () => callTool("kosis_export_excel", { endpoint: "Param/statisticsParameterData.do", parameters: { orgId: "101", tblId: "TEST", prdSe: "Y", startPrdDe: "2024", endPrdDe: "2024", itmId: "ALL", objL1: "ALL" } }))
    const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes! as any)
    expect(book.getWorksheet("데이터")!.getCell("A2").value).toBe("=1+1")
    expect(book.getWorksheet("데이터")!.getCell("B2").value).toBe(12.5)
    expect(JSON.stringify(book.getWorksheet("출처")!.getSheetValues())).not.toContain("fixture-secret-token")
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs() }
})
