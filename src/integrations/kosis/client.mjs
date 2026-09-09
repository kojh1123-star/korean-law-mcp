import process from "node:process";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { AsyncLocalStorage } from "node:async_hooks";
import { getRequestSignal } from "../../lib/session-state.js";
export const exportContext = new AsyncLocalStorage();

const SERVER_NAME = "kosis-web";
const SERVER_VERSION = "1.1.0";
const API_BASE = "https://kosis.kr/openapi/";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPORT_DIR = path.join(PROJECT_ROOT, "outputs", "kosis");
const ALLOWED_ENDPOINTS = new Set([
  "statisticsList.do",
  "statisticsData.do",
  "Param/statisticsParameterData.do",
]);

export const serverInstructions = [
  "KOSIS 공식통계 조회용 웹 MCP 서버입니다.",
  "표 이름과 갱신일을 확인한 뒤 필요한 자료만 조회하세요.",
  "orgId와 tblId로 조회할 때는 파라미터 통계자료 API를 사용하며, userStatsId가 있을 때만 등록 통계자료 API를 사용합니다.",
  "통계표 내부 항목은 kosis_get_table_meta 또는 kosis_search_items로 먼저 확인하세요.",
  "음식물, 슬러지, 생활폐기물, 재활용, 분뇨는 중복을 피하기 위해 우선분류와 검토필요 여부를 함께 확인하세요.",
  "대량 결과는 kosis_export_excel로 생성하고 반환된 다운로드 링크를 사용자에게 전달하세요. 파일은 해당 직원의 로그인으로 최대 24시간 다운로드하며 서버 재시작 시 만료됩니다.",
].join(" ");

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const tools = [
  {
    name: "kosis_list_catalog",
    description: "KOSIS 주제별 통계 분류 또는 특정 분류 아래의 통계표 목록을 조회합니다.",
    inputSchema: {
      type: "object",
      properties: {
        parent_list_id: { type: "string", description: "상위 목록 ID. 최상위는 빈 문자열, 환경은 T입니다." },
        view_code: { type: "string", description: "KOSIS 보기 코드", default: "MT_ZTITLE" },
      },
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: "kosis_search_tables",
    description: "KOSIS 분류를 제한된 깊이로 탐색해 이름에 검색어가 포함된 목록과 통계표을 찾습니다.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", minLength: 1, description: "예: 폐기물, 음식물, 슬러지, 분뇨" },
        parent_list_id: { type: "string", default: "T", description: "검색 시작 목록 ID. 기본값 T(환경)." },
        view_code: { type: "string", default: "MT_ZTITLE" },
        max_depth: { type: "integer", minimum: 0, maximum: 5, default: 3 },
        max_requests: { type: "integer", minimum: 1, maximum: 80, default: 40 },
      },
      required: ["keyword"],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: "kosis_get_data",
    description: "KOSIS 통계자료를 조회합니다. orgId/tblId 요청은 statisticsParameterData.do로, userStatsId 요청은 statisticsData.do로 자동 분기합니다.",
    inputSchema: {
      type: "object",
      properties: {
        parameters: {
          type: "object",
          description: "apiKey를 제외한 KOSIS 통계자료 요청 파라미터",
          additionalProperties: { type: ["string", "number", "boolean"] },
        },
        max_rows: { type: "integer", minimum: 1, maximum: 2000, default: 200 },
      },
      required: ["parameters"],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: "kosis_get_table_meta",
    description: "통계표의 명칭, 수록시점, 분류·항목·단위, 출처 메타데이터를 조회합니다. 내부 폐기물 항목 확인에는 meta_type=ITM을 사용하세요.",
    inputSchema: {
      type: "object",
      properties: {
        org_id: { type: "string", minLength: 1, description: "기관 ID" },
        tbl_id: { type: "string", minLength: 1, description: "통계표 ID" },
        meta_type: { type: "string", enum: ["TBL", "PRD", "ITM", "SOURCE"], default: "ITM" },
        obj_id: { type: "string", description: "분류코드 필터(선택)" },
        itm_id: { type: "string", description: "자료코드 필터(선택)" },
        max_rows: { type: "integer", minimum: 1, maximum: 5000, default: 2000 },
      },
      required: ["org_id", "tbl_id"],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: "kosis_search_items",
    description: "여러 KOSIS 통계표의 내부 분류·항목명을 검색합니다. 의복류·폐의류·섬유류·헌옷 또는 폐식용유·폐유처럼 서로 다른 후보를 개별 키워드로 유지합니다.",
    inputSchema: {
      type: "object",
      properties: {
        keywords: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: { type: "string", minLength: 1 },
        },
        tables: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              org_id: { type: "string", minLength: 1 },
              tbl_id: { type: "string", minLength: 1 },
              table_name: { type: "string" },
              survey_year: { type: "string" },
            },
            required: ["org_id", "tbl_id"],
            additionalProperties: false,
          },
        },
        match_mode: { type: "string", enum: ["contains", "exact"], default: "contains" },
        max_rows_per_table: { type: "integer", minimum: 1, maximum: 5000, default: 5000 },
      },
      required: ["keywords", "tables"],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: "kosis_classify_waste",
    description: "표명이나 자료명을 음식물, 슬러지, 생활폐기물, 재활용, 분뇨로 우선분류하고 중복 신호를 표시합니다.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 1000,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string", minLength: 1 },
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    annotations: { ...readOnly, openWorldHint: false },
  },
  {
    name: "kosis_export_excel",
    description: "KOSIS 목록 또는 통계자료 응답을 새 Excel 파일로 저장합니다. 기존 파일은 덮어쓰지 않으며 출처 시트를 함께 만듭니다.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", enum: ["statisticsList.do", "statisticsData.do", "Param/statisticsParameterData.do"], default: "Param/statisticsParameterData.do" },
        parameters: {
          type: "object",
          description: "apiKey를 제외한 KOSIS 요청 파라미터",
          additionalProperties: { type: ["string", "number", "boolean"] },
        },
        output_name: { type: "string", description: "경로가 아닌 파일명만 입력합니다. .xlsx는 생략할 수 있습니다." },
      },
      required: ["parameters"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];

function getApiKey() {
  const value = process.env.KOSIS_TOKEN?.trim();
  if (!value) throw new Error("KOSIS_TOKEN 환경변수가 MCP 서버에 전달되지 않았습니다.");
  return value;
}

function cleanParameters(parameters = {}) {
  if (parameters == null || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new Error("parameters는 이름과 값으로 구성된 객체여야 합니다.");
  }
  const result = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error(`허용되지 않는 파라미터 이름: ${key}`);
    if (key.toLowerCase() === "apikey") throw new Error("apiKey는 도구 인수가 아니라 KOSIS_TOKEN 환경변수로 관리합니다.");
    if (!["string", "number", "boolean"].includes(typeof value)) throw new Error(`허용되지 않는 파라미터 값 형식: ${key}`);
    result[key] = String(value);
  }
  return result;
}

function makeUrl(endpoint, parameters) {
  if (!ALLOWED_ENDPOINTS.has(endpoint)) throw new Error(`허용되지 않는 KOSIS 엔드포인트: ${endpoint}`);
  const url = new URL(endpoint, API_BASE);
  const merged = {
    method: "getList",
    format: "json",
    jsonVD: "Y",
    ...cleanParameters(parameters),
    apiKey: getApiKey(),
  };
  for (const [key, value] of Object.entries(merged)) url.searchParams.set(key, value);
  return url;
}

function safeUrl(url) {
  const copy = new URL(url);
  if (copy.searchParams.has("apiKey")) copy.searchParams.set("apiKey", "***");
  return copy.toString();
}

async function requestKosis(endpoint, parameters) {
  const url = makeUrl(endpoint, parameters);
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}` },
      signal: AbortSignal.any([AbortSignal.timeout(60000), ...(getRequestSignal() ? [getRequestSignal()] : [])]),
      redirect: "error",
    });
  } catch (error) {
    throw new Error(`KOSIS 연결 실패: ${error.message}`);
  }
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body || []) { bytes += chunk.byteLength; if (bytes > 20 * 1024 * 1024) throw new Error("KOSIS 응답이 20MB를 초과했습니다. 조회 범위를 줄여주세요."); chunks.push(Buffer.from(chunk)); }
  let text = Buffer.concat(chunks).toString("utf8");
  for (const key of [getApiKey(), encodeURIComponent(getApiKey())]) text = text.split(key).join("[REDACTED]");
  if (!response.ok) throw new Error(`KOSIS HTTP ${response.status}: ${text.slice(0, 500)}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`KOSIS 응답이 JSON이 아닙니다: ${text.slice(0, 500)}`);
  }
  const rows = Array.isArray(data) ? data : [data];
  const errorRow = rows.find((row) => row && typeof row === "object" && row.err);
  if (errorRow) throw new Error(`KOSIS 오류 ${errorRow.err}: ${errorRow.errMsg ?? "원인 미상"}`);
  return { data, requestUrl: safeUrl(url), status: response.status };
}

function rowsFrom(data) {
  return Array.isArray(data) ? data : [data];
}

function limitRows(rows, requested, hardLimit = 5000) {
  const maxRows = Math.min(hardLimit, Math.max(1, Number(requested ?? hardLimit)));
  return {
    row_count: rows.length,
    returned_count: Math.min(rows.length, maxRows),
    truncated: rows.length > maxRows,
    rows: rows.slice(0, maxRows),
  };
}

function requireString(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${name}이(가) 필요합니다.`);
  return normalized;
}

function registeredDataRequest(parameters) {
  return Boolean(String(parameters?.userStatsId ?? "").trim());
}

function normalizePeriodCode(value) {
  const raw = String(value ?? "").trim();
  const aliases = new Map([
    ["일", "D"],
    ["월", "M"],
    ["격월", "M"],
    ["분기", "Q"],
    ["반기", "S"],
    ["년", "Y"],
    ["연", "Y"],
    ["부정기", "IR"],
  ]);
  if (aliases.has(raw)) return aliases.get(raw);
  if (/^\d+년$/.test(raw)) return "F";
  return raw;
}

function normalizeDataParameters(parameters) {
  const normalized = { ...parameters };
  if (Object.hasOwn(normalized, "prdSe")) normalized.prdSe = normalizePeriodCode(normalized.prdSe);
  return normalized;
}

function validateDataParameters(parameters) {
  if (registeredDataRequest(parameters)) {
    requireString(parameters.prdSe, "prdSe");
    return "statisticsData.do";
  }
  for (const key of ["orgId", "tblId", "itmId", "objL1", "prdSe"]) {
    requireString(parameters?.[key], key);
  }
  return "Param/statisticsParameterData.do";
}

async function getTableMeta(args) {
  const orgId = requireString(args.org_id, "org_id");
  const tblId = requireString(args.tbl_id, "tbl_id");
  const metaType = String(args.meta_type ?? "ITM").trim().toUpperCase();
  const allowedMetaTypes = new Set(["TBL", "PRD", "ITM", "SOURCE"]);
  if (!allowedMetaTypes.has(metaType)) throw new Error(`지원하지 않는 meta_type: ${metaType}`);

  const parameters = { method: "getMeta", type: metaType, orgId, tblId };
  if (args.obj_id) parameters.objId = String(args.obj_id);
  if (args.itm_id) parameters.itmId = String(args.itm_id);
  const result = await requestKosis("statisticsData.do", parameters);
  const limited = limitRows(rowsFrom(result.data), args.max_rows, 5000);
  return {
    org_id: orgId,
    tbl_id: tblId,
    meta_type: metaType,
    ...limited,
    request_url: result.requestUrl,
  };
}

function normalizedSearchText(value) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("ko-KR");
}

function itemFields(row) {
  return [
    ["ITM_NM", row?.ITM_NM],
    ["OBJ_NM", row?.OBJ_NM],
  ].filter(([, value]) => value != null && String(value).trim());
}

async function searchItems(args) {
  const keywords = [...new Set((args.keywords ?? []).map((value) => String(value).trim()).filter(Boolean))];
  if (!keywords.length) throw new Error("keywords가 필요합니다.");
  const tables = args.tables ?? [];
  if (!tables.length) throw new Error("tables가 필요합니다.");
  const matchMode = String(args.match_mode ?? "contains");
  const matches = [];
  const tableResults = [];

  for (const table of tables) {
    const orgId = requireString(table.org_id, "tables[].org_id");
    const tblId = requireString(table.tbl_id, "tables[].tbl_id");
    const result = await requestKosis("statisticsData.do", {
      method: "getMeta",
      type: "ITM",
      orgId,
      tblId,
    });
    const allRows = rowsFrom(result.data);
    const limited = limitRows(allRows, args.max_rows_per_table, 5000);
    tableResults.push({
      org_id: orgId,
      tbl_id: tblId,
      table_name: table.table_name ?? null,
      survey_year: table.survey_year ?? null,
      metadata_row_count: allRows.length,
      searched_row_count: limited.rows.length,
      truncated: limited.truncated,
      request_url: result.requestUrl,
    });

    for (const row of limited.rows) {
      for (const [field, rawValue] of itemFields(row)) {
        const candidate = normalizedSearchText(rawValue);
        for (const keyword of keywords) {
          const needle = normalizedSearchText(keyword);
          const matched = matchMode === "exact" ? candidate === needle : candidate.includes(needle);
          if (!matched) continue;
          matches.push({
            keyword,
            matched_field: field,
            matched_value: rawValue,
            survey_year: table.survey_year ?? null,
            org_id: orgId,
            tbl_id: tblId,
            table_name: table.table_name ?? null,
            metadata: row,
          });
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    keywords,
    match_mode: matchMode,
    table_count: tables.length,
    match_count: matches.length,
    matches,
    table_results: tableResults,
  };
}

async function listCatalog(parentListId = "", viewCode = "MT_ZTITLE") {
  const result = await requestKosis("statisticsList.do", {
    vwCd: viewCode,
    parentListId,
  });
  return {
    parent_list_id: parentListId,
    view_code: viewCode,
    count: Array.isArray(result.data) ? result.data.length : 1,
    rows: Array.isArray(result.data) ? result.data : [result.data],
    request_url: result.requestUrl,
  };
}

function rowName(row) {
  return String(row?.TBL_NM ?? row?.LIST_NM ?? row?.STAT_NM ?? "");
}

async function searchTables(args) {
  const keyword = String(args.keyword ?? "").trim();
  if (!keyword) throw new Error("keyword가 필요합니다.");
  const start = String(args.parent_list_id ?? "T");
  const viewCode = String(args.view_code ?? "MT_ZTITLE");
  const maxDepth = Math.min(5, Math.max(0, Number(args.max_depth ?? 3)));
  const maxRequests = Math.min(80, Math.max(1, Number(args.max_requests ?? 40)));
  const queue = [{ id: start, depth: 0 }];
  const visited = new Set();
  const matches = [];
  let requests = 0;

  while (queue.length && requests < maxRequests) {
    const current = queue.shift();
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    const response = await listCatalog(current.id, viewCode);
    requests += 1;
    for (const row of response.rows) {
      const name = rowName(row);
      if (name.includes(keyword)) matches.push({ parent_list_id: current.id, ...row });
      const childId = row?.LIST_ID;
      if (childId && !row?.TBL_ID && current.depth < maxDepth && !visited.has(childId)) {
        queue.push({ id: String(childId), depth: current.depth + 1 });
      }
    }
    if (queue.length) await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return {
    keyword,
    start_parent_list_id: start,
    requests_used: requests,
    stopped_by_request_limit: queue.length > 0,
    match_count: matches.length,
    matches,
  };
}

function classifyOne(item) {
  const name = String(item.name);
  const signals = [];
  if (/음식물|음식류/.test(name)) signals.push("음식물");
  if (/슬러지|하수찌꺼기|하수오니|폐수오니/.test(name)) signals.push("슬러지");
  if (/분뇨|정화조/.test(name)) signals.push("분뇨");
  if (/재활용|재생자원|폐지|폐플라스틱|폐유리|고철/.test(name)) signals.push("재활용");
  if (/생활폐기물|생활계|종량제/.test(name)) signals.push("생활폐기물");
  const priority = ["음식물", "슬러지", "분뇨", "재활용", "생활폐기물"];
  const primary = priority.find((category) => signals.includes(category)) ?? "검토필요";
  return {
    id: item.id ?? null,
    name,
    primary_category: primary,
    matched_signals: signals,
    review_required: signals.length !== 1,
  };
}

function sanitizeFileName(value) {
  let name = String(value || "KOSIS_통계자료").trim();
  name = name.replace(/[\\/:*?"<>|]/g, "_").replace(/\.+$/g, "");
  if (!name) name = "KOSIS_통계자료";
  if (!name.toLowerCase().endsWith(".xlsx")) name += ".xlsx";
  return name.slice(0, 180);
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function fitColumns(rows) {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row ?? {})))];
  return keys.map((key) => {
    let width = Math.max(10, String(key).length + 2);
    for (const row of rows.slice(0, 500)) width = Math.max(width, String(row?.[key] ?? "").length + 2);
    return { wch: Math.min(45, width) };
  });
}

async function exportExcel(args) {
  const endpoint=String(args.endpoint ?? "Param/statisticsParameterData.do");
  const result=await requestKosis(endpoint,args.parameters ?? {});
  const rows=Array.isArray(result.data)?result.data:[result.data];
  if(!rows.length || rows.length>50000) throw new Error("엑셀은 1~50,000행으로 조회 범위를 조정해주세요.");
  const save=exportContext.getStore(); if(!save)throw new Error("직원 로그인으로 엑셀을 생성해주세요.");
  const book=new ExcelJS.Workbook(); const sheet=book.addWorksheet("데이터");
  const keys=[...new Set(rows.flatMap(row=>Object.keys(row ?? {})))];
  if(keys.length>200) throw new Error("응답 열 수가 너무 많습니다.");
  sheet.columns=keys.map(key=>({header:key,key,width:24}));
  for(const row of rows) sheet.addRow(keys.map(key=>{const value=row[key];return value==null?null:typeof value==="number"||typeof value==="boolean"?value:String(typeof value==="object"?JSON.stringify(value):value)}));
  sheet.autoFilter={from:{row:1,column:1},to:{row:1,column:Math.max(1,keys.length)}};
  sheet.views=[{state:"frozen",ySplit:1}];
  const source=book.addWorksheet("출처");source.columns=[{header:"항목",key:"label",width:20},{header:"값",key:"value",width:90}];
  source.addRows([["출처","KOSIS 국가통계포털 OpenAPI"],["요청일시",new Date().toISOString()],["엔드포인트",endpoint],["요청주소",result.requestUrl],["요청파라미터",JSON.stringify(cleanParameters(args.parameters ?? {}))],["응답행수",rows.length]]);
  const buffer=Buffer.from(await book.xlsx.writeBuffer());
  return {...await save(buffer,sanitizeFileName(args.output_name)),row_count:rows.length,endpoint,request_url:result.requestUrl};
}

export async function callTool(name, args) {
  switch (name) {
    case "kosis_list_catalog":
      return listCatalog(String(args.parent_list_id ?? ""), String(args.view_code ?? "MT_ZTITLE"));
    case "kosis_search_tables":
      return searchTables(args);
    case "kosis_get_data": {
      const parameters = normalizeDataParameters(args.parameters ?? {});
      const endpoint = validateDataParameters(parameters);
      const result = await requestKosis(endpoint, parameters);
      const limited = limitRows(rowsFrom(result.data), args.max_rows ?? 200, 2000);
      return {
        endpoint,
        ...limited,
        request_url: result.requestUrl,
      };
    }
    case "kosis_get_table_meta":
      return getTableMeta(args);
    case "kosis_search_items":
      return searchItems(args);
    case "kosis_classify_waste":
      return { results: (args.items ?? []).map(classifyOne) };
    case "kosis_export_excel":
      return exportExcel(args);
    default:
      throw new Error(`알 수 없는 도구: ${name}`);
  }
}
