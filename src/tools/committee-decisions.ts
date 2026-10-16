import { z } from "zod";
import type { LawApiClient } from "../lib/api-client.js";
import { truncateResponse } from "../lib/schemas.js";
import { parseSearchXML, extractTag } from "../lib/xml-parser.js";
import { formatToolError, noResultHint } from "../lib/errors.js";
import { decisionFields } from "../lib/decision-fields.js";
import { fieldText } from "../lib/precedent-body.js";

// Common schema for committee decision search (query optional)
const baseSearchSchemaOptionalQuery = {
  query: z.string().optional().describe("검색 키워드"),
  display: z.number().min(1).max(100).default(20).describe("페이지당 결과 개수 (기본값: 20, 최대: 100)"),
  page: z.number().min(1).default(1).describe("페이지 번호 (기본값: 1)"),
  sort: z.enum(["lasc", "ldes", "dasc", "ddes"]).optional()
    .describe("정렬 옵션: lasc/ldes (법령명순), dasc/ddes (날짜순)"),
  apiKey: z.string().optional().describe("법제처 Open API 인증키(OC). 사용자가 제공한 경우 전달"),
};

// Common schema for committee decision search (query required)
const baseSearchSchemaRequiredQuery = {
  display: z.number().min(1).max(100).default(20).describe("페이지당 결과 개수 (기본값: 20, 최대: 100)"),
  page: z.number().min(1).default(1).describe("페이지 번호 (기본값: 1)"),
  sort: z.enum(["lasc", "ldes", "dasc", "ddes"]).optional()
    .describe("정렬 옵션: lasc/ldes (법령명순), dasc/ddes (날짜순)"),
  apiKey: z.string().optional().describe("법제처 Open API 인증키(OC). 사용자가 제공한 경우 전달"),
};

const baseTextSchema = {
  id: z.string().describe("결정문 일련번호 (검색 결과에서 획득)"),
  apiKey: z.string().optional().describe("법제처 Open API 인증키(OC). 사용자가 제공한 경우 전달"),
};

// ========================================
// 공정거래위원회 결정문 (FTC Decisions)
// ========================================

export const searchFtcDecisionsSchema = z.object({
  ...baseSearchSchemaRequiredQuery,
  query: z.string().describe("검색 키워드 (필수, 예: '담합', '불공정거래', '시정명령')"),
});

export type SearchFtcDecisionsInput = z.infer<typeof searchFtcDecisionsSchema>;

export async function searchFtcDecisions(
  apiClient: LawApiClient,
  args: SearchFtcDecisionsInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return searchCommitteeDecisions(apiClient, args, "ftc", "공정거래위원회 결정문", "get_ftc_decision_text");
}

export const getFtcDecisionTextSchema = z.object(baseTextSchema);
export type GetFtcDecisionTextInput = z.infer<typeof getFtcDecisionTextSchema>;

export async function getFtcDecisionText(
  apiClient: LawApiClient,
  args: GetFtcDecisionTextInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return getCommitteeDecisionText(apiClient, args, "ftc", "공정거래위원회 결정문");
}

// ========================================
// 개인정보보호위원회 결정문 (PIPC Decisions)
// ========================================

export const searchPipcDecisionsSchema = z.object({
  ...baseSearchSchemaRequiredQuery,
  query: z.string().describe("검색 키워드 (필수, 예: '개인정보', '유출', '과징금')"),
});

export type SearchPipcDecisionsInput = z.infer<typeof searchPipcDecisionsSchema>;

export async function searchPipcDecisions(
  apiClient: LawApiClient,
  args: SearchPipcDecisionsInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return searchCommitteeDecisions(apiClient, args, "ppc", "개인정보보호위원회 결정문", "get_pipc_decision_text");
}

export const getPipcDecisionTextSchema = z.object(baseTextSchema);
export type GetPipcDecisionTextInput = z.infer<typeof getPipcDecisionTextSchema>;

export async function getPipcDecisionText(
  apiClient: LawApiClient,
  args: GetPipcDecisionTextInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return getCommitteeDecisionText(apiClient, args, "ppc", "개인정보보호위원회 결정문");
}

// ========================================
// 중앙노동위원회 결정문 (NLRC Decisions)
// ========================================

export const searchNlrcDecisionsSchema = z.object({
  ...baseSearchSchemaOptionalQuery,
  query: z.string().optional().describe("검색 키워드 (예: '부당해고', '노동쟁의', '조정')"),
});

export type SearchNlrcDecisionsInput = z.infer<typeof searchNlrcDecisionsSchema>;

export async function searchNlrcDecisions(
  apiClient: LawApiClient,
  args: SearchNlrcDecisionsInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return searchCommitteeDecisions(apiClient, args, "nlrc", "중앙노동위원회 결정문", "get_nlrc_decision_text");
}

export const getNlrcDecisionTextSchema = z.object(baseTextSchema);
export type GetNlrcDecisionTextInput = z.infer<typeof getNlrcDecisionTextSchema>;

export async function getNlrcDecisionText(
  apiClient: LawApiClient,
  args: GetNlrcDecisionTextInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return getCommitteeDecisionText(apiClient, args, "nlrc", "중앙노동위원회 결정문");
}

// ========================================
// 산업재해보상보험재심사위원회 결정문 (IACIAC Decisions)
// ========================================

export const searchIaciacDecisionsSchema = z.object({
  ...baseSearchSchemaOptionalQuery,
  query: z.string().optional().describe("검색 키워드 (예: '요양불승인', '유족급여', '뇌심혈관')"),
});

export type SearchIaciacDecisionsInput = z.infer<typeof searchIaciacDecisionsSchema>;

/** 산재보험재심사위원회 재결 검색 — 목록 제목 태그가 `<사건>`(사건명 아님). unified-decisions만 사용 */
export async function searchIaciacDecisions(
  apiClient: LawApiClient,
  args: SearchIaciacDecisionsInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return searchCommitteeDecisions(apiClient, args, "iaciac", "산업재해보상보험재심사위원회 결정문", "get_decision_text");
}

export const getIaciacDecisionTextSchema = z.object(baseTextSchema);
export type GetIaciacDecisionTextInput = z.infer<typeof getIaciacDecisionTextSchema>;

export async function getIaciacDecisionText(
  apiClient: LawApiClient,
  args: GetIaciacDecisionTextInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return getCommitteeDecisionText(apiClient, args, "iaciac", "산업재해보상보험재심사위원회 결정문");
}

// ========================================
// 고용보험심사위원회 결정문 (EIAC Decisions)
// ========================================

export const searchEiacDecisionsSchema = z.object({
  ...baseSearchSchemaOptionalQuery,
  query: z.string().optional().describe("검색 키워드 (예: '구직급여', '수급자격', '육아휴직급여')"),
});

export type SearchEiacDecisionsInput = z.infer<typeof searchEiacDecisionsSchema>;

/** 고용보험심사위원회 재결 검색. unified-decisions만 사용 */
export async function searchEiacDecisions(
  apiClient: LawApiClient,
  args: SearchEiacDecisionsInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return searchCommitteeDecisions(apiClient, args, "eiac", "고용보험심사위원회 결정문", "get_decision_text");
}

export const getEiacDecisionTextSchema = z.object(baseTextSchema);
export type GetEiacDecisionTextInput = z.infer<typeof getEiacDecisionTextSchema>;

export async function getEiacDecisionText(
  apiClient: LawApiClient,
  args: GetEiacDecisionTextInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return getCommitteeDecisionText(apiClient, args, "eiac", "고용보험심사위원회 결정문");
}

// ========================================
// 국민권익위원회 결정문 (ACR Decisions)
// ========================================

export const searchAcrDecisionsSchema = z.object({
  ...baseSearchSchemaOptionalQuery,
  query: z.string().optional().describe("검색 키워드 (예: '행정심판', '고충민원', '부패행위')"),
});

export type SearchAcrDecisionsInput = z.infer<typeof searchAcrDecisionsSchema>;

export async function searchAcrDecisions(
  apiClient: LawApiClient,
  args: SearchAcrDecisionsInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return searchCommitteeDecisions(apiClient, args, "acr", "국민권익위원회 결정문", "get_acr_decision_text");
}

export const getAcrDecisionTextSchema = z.object(baseTextSchema);
export type GetAcrDecisionTextInput = z.infer<typeof getAcrDecisionTextSchema>;

export async function getAcrDecisionText(
  apiClient: LawApiClient,
  args: GetAcrDecisionTextInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return getCommitteeDecisionText(apiClient, args, "acr", "국민권익위원회 결정문");
}

// ========================================
// Common Implementation
// ========================================

async function searchCommitteeDecisions(
  apiClient: LawApiClient,
  args: { query?: string; display?: number; page?: number; sort?: string; apiKey?: string },
  target: string,
  committeeName: string,
  textToolName: string
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  try {
    const extraParams: Record<string, string> = {
      display: (args.display || 20).toString(),
      page: (args.page || 1).toString(),
    };
    if (args.query) extraParams.query = args.query;
    if (args.sort) extraParams.sort = args.sort;

    const xmlText = await apiClient.fetchApi({
      endpoint: "lawSearch.do",
      target,
      extraParams,
      apiKey: args.apiKey,
    });

    // parseSearchXML 사용 (rootTag: searchKey, itemTag: target)
    const searchKey = getSearchKey(target);
    const itemKey = target.toLowerCase();
    const { totalCnt, page: currentPage, items: decisions } = parseSearchXML(
      xmlText, searchKey, itemKey,
      (content) => ({
        결정일련번호: extractTag(content, "결정문일련번호") || extractTag(content, "결정일련번호") || extractTag(content, "판례일련번호") || extractTag(content, "일련번호"),
        // 산재보험재심사위원회(iaciac) 목록은 제목을 `<사건>`에 담는다 (extractTag 는 태그명 정확 일치라 `<사건번호>`와 섞이지 않음)
        사건명: extractTag(content, "사건명") || extractTag(content, "안건명") || extractTag(content, "제목") || extractTag(content, "사건"),
        사건번호: extractTag(content, "사건번호") || extractTag(content, "의안번호"),
        결정일자: extractTag(content, "결정일자") || extractTag(content, "의결일자") || extractTag(content, "의결일") || extractTag(content, "선고일자") || extractTag(content, "판정일자"),
        등록일: extractTag(content, "등록일"),
        결정유형: extractTag(content, "결정유형") || extractTag(content, "결정구분") || extractTag(content, "판결유형") || extractTag(content, "회의종류"),
        재결청: extractTag(content, "재결청") || extractTag(content, "기관명"),
        상세링크: extractTag(content, "결정문상세링크") || extractTag(content, "상세링크") || extractTag(content, "판례상세링크"),
      }),
      { useIndexOf: true }
    );

    const totalCount = totalCnt;

    if (totalCount === 0) {
      return noResultHint(args.query || "", committeeName)
    }

    let output = `${committeeName} 검색 결과 (총 ${totalCount}건, ${currentPage}페이지):\n\n`;

    for (const decision of decisions) {
      const title = decision.사건명 || "(제목 없음)";
      output += `[${decision.결정일련번호}] ${title}\n`;
      if (decision.사건번호) output += `  사건번호: ${decision.사건번호}\n`;
      if (decision.결정일자) output += `  결정일: ${decision.결정일자}\n`;
      if (decision.등록일) output += `  등록일: ${decision.등록일}\n`;
      if (decision.결정유형) output += `  결정유형: ${decision.결정유형}\n`;
      if (decision.재결청) output += `  재결청: ${decision.재결청}\n`;
      if (decision.상세링크) output += `  링크: ${decision.상세링크}\n`;
      output += `\n`;
    }

    // 후속 도구 안내 제거 (LLM이 이미 도구 목록을 알고 있음)

    return {
      content: [{
        type: "text",
        text: truncateResponse(output)
      }]
    };
  } catch (error) {
    return formatToolError(error, `search_${target}_decisions`);
  }
}

async function getCommitteeDecisionText(
  apiClient: LawApiClient,
  args: { id: string; apiKey?: string },
  target: string,
  committeeName: string
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  try {
    const responseText = await apiClient.fetchApi({
      endpoint: "lawService.do",
      target,
      type: "JSON",
      extraParams: { ID: args.id },
      apiKey: args.apiKey,
    });

    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch (err) {
      throw new Error("Failed to parse JSON response from API");
    }

    const serviceKey = getServiceKey(target);
    if (!data[serviceKey]) {
      throw new Error(`${committeeName}을(를) 찾을 수 없거나 응답 형식이 올바르지 않습니다.`);
    }

    const record = data[serviceKey];
    const rawDecision = record.의결서 || record;
    const decision = decisionFields(rawDecision);
    // 산재·고용보험 재심사 재결은 본문에 숨김 요약 span·<각주>·<img> 태그가 섞여 온다 — 이 두 위원회만 정리
    if (REVIEW_COMMITTEE_TARGETS.has(target)) {
      for (const key of Object.keys(decision)) decision[key] = cleanReviewCommitteeText(decision[key]);
    }

    let output = `=== ${decision.사건명 || decision.안건명 || decision.제목 || decision.사건 || committeeName} ===\n\n`;

    output += `기본 정보:\n`;
    output += `  사건번호: ${decision.사건번호 || decision.안건번호 || decision.의안번호 || decision.결정번호 || "N/A"}\n`;
    output += `  결정일자: ${decision.결정일자 || decision.의결일자 || decision.의결연월일 || decision.의결일 || decision.판정일자 || "N/A"}\n`;
    if (decision.등록일) output += `  등록일: ${decision.등록일}\n`;
    output += `  결정유형: ${decision.결정유형 || decision.결정구분 || decision.회의종류 || decision.자료구분 || decision.의결서종류 || "N/A"}\n`;
    if (decision.판정결과) output += `  판정결과: ${decision.판정결과}\n`;
    if (decision.당사자) output += `  당사자: ${decision.당사자}\n`;
    if (decision.피심인) output += `  피심인: ${decision.피심인}\n`;
    const isReviewCommittee = REVIEW_COMMITTEE_TARGETS.has(target);
    if (isReviewCommittee) {
      const category = [decision.사건대분류, decision.사건중분류, decision.사건소분류].filter(Boolean).join(" > ") || decision.사건의분류;
      if (category) output += `  사건분류: ${category}\n`;
      if (decision.원처분기관) output += `  원처분기관: ${decision.원처분기관}\n`;
      if (decision.피청구인) output += `  피청구인: ${decision.피청구인}\n`;
    }
    output += `\n`;

    if (decision.주문) {
      output += `주문:\n${decision.주문}\n\n`;
    }

    if (isReviewCommittee) {
      if (decision.청구취지) output += `청구취지:\n${decision.청구취지}\n\n`;
      if (decision.쟁점) output += `쟁점:\n${decision.쟁점}\n\n`;
      if (decision.개요) output += `개요:\n${decision.개요}\n\n`;
    }

    if (decision.판정사항) output += `판정사항:\n${decision.판정사항}\n\n`;

    if (decision.결정요지 || decision.요지 || decision.판정요지) {
      output += `결정요지:\n${decision.결정요지 || decision.요지 || decision.판정요지}\n\n`;
    }

    if (decision.이유) {
      output += `이유:\n${decision.이유}\n\n`;
    }

    if (decision.참조조문) {
      output += `참조조문:\n${decision.참조조문}\n\n`;
    }

    if (decision.결정내용 || decision.전문 || decision.내용 || decision.의결문 || decision.주요내용) {
      output += `전문:\n${decision.결정내용 || decision.전문 || decision.내용 || decision.의결문 || decision.주요내용}\n`;
    }

    const footnotes = REVIEW_COMMITTEE_TARGETS.has(target) ? renderFootnotes(rawDecision?.각주목록) : "";
    if (footnotes) output += `\n각주:\n${footnotes}\n`;

    return {
      content: [{
        type: "text",
        text: truncateResponse(output)
      }]
    };
  } catch (error) {
    return formatToolError(error, `get_${target}_decision_text`);
  }
}

// Helper functions

/** 산재보험재심사(iaciac)·고용보험심사(eiac) 재결 — 본문 HTML 정리·각주 렌더 대상 */
const REVIEW_COMMITTEE_TARGETS: ReadonlySet<string> = new Set(["iaciac", "eiac"]);

/**
 * 재결 본문 정리: 화면 숨김 요약(`<span style="display:none;">…</span>`)은 주문·청구취지를 중복하므로 버리고,
 * `<각주>N</각주>` 는 [각주N] 표지로, `<img>` 는 [이미지] 표지로 남긴 뒤 나머지 태그를 걷는다.
 */
export function cleanReviewCommitteeText(text: string): string {
  if (!text || !text.includes("<")) return text;
  return text
    .replace(/<span[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/span>/gi, "")
    .replace(/<각주>\s*(\d+)\s*<\/각주>/g, "[각주$1]")
    .replace(/<img\b[^>]*>(?:\s*<\/img>)?/gi, "[이미지]")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/** 고용보험심사위원회 재결의 `각주목록: { 각주번호: [...], 각주내용: [...] }` → "[1] 내용" 줄 목록 */
function renderFootnotes(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const rec = raw as Record<string, unknown>;
  const toList = (v: unknown): string[] => (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => cleanReviewCommitteeText(fieldText(x)));
  const numbers = toList(rec.각주번호);
  const contents = toList(rec.각주내용);
  return contents
    .map((content, i) => (content ? `[${numbers[i] || i + 1}] ${content}` : ""))
    .filter(Boolean)
    .join("\n");
}

function getSearchKey(target: string): string {
  const mapping: Record<string, string> = {
    ftc: "Ftc",
    ppc: "Ppc",
    nlrc: "Nlrc",
    acr: "Acr",
    iaciac: "Iaciac",
    eiac: "Eiac",
  };
  return mapping[target] || `${target.charAt(0).toUpperCase() + target.slice(1)}`;
}

function getServiceKey(target: string): string {
  const mapping: Record<string, string> = {
    ftc: "FtcService",
    ppc: "PpcService",
    nlrc: "NlrcService",
    acr: "AcrService",
    iaciac: "IaciacService",
    eiac: "EiacService",
  };
  return mapping[target] || `${target.charAt(0).toUpperCase() + target.slice(1)}Service`;
}
