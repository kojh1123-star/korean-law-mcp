import { serviceForPath } from "./services.js"
export const TRAFFIC_GROUPS = ["law", "g2b", "kosis", "oauth", "admin", "downloads", "health", "other"] as const
export type TrafficGroup = typeof TRAFFIC_GROUPS[number]
export const TRAFFIC_STAGE_LABELS = {
  legacy: "이전 기록", oauth_metadata: "연결 정보 확인", oauth_register: "앱 등록",
  oauth_authorize: "OAuth 연결 시작·복귀", oauth_interaction: "OAuth 로그인·동의",
  oauth_token: "토큰 교환·갱신", oauth_par: "연결 요청 등록 (PAR)", oauth_revoke: "연결 해제", oauth_other: "OAuth 연결 준비",
  mcp_auth: "MCP 인증 필요·거절", mcp_initialize: "연결 초기화 (initialize)",
  mcp_initialized: "준비 완료 (initialized)", mcp_tools_list: "도구 목록 (tools/list)",
  mcp_tools_call: "도구 실행 (tools/call)", mcp_ping: "MCP 응답 확인", mcp_batch: "MCP 묶음 요청",
  mcp_request: "기타 MCP 요청", other: "기타 요청",
} as const
export type TrafficStage = keyof typeof TRAFFIC_STAGE_LABELS
export interface TrafficEvent {
  group: TrafficGroup; method: string; status: number; auth: "employee" | "machine" | "anonymous";
  accountId?: string; calls: number; stage?: TrafficStage;
}
export function trafficGroup(path: string): TrafficGroup {
  return serviceForPath(path) || (path === "/health" || path === "/" ? "health"
    : path.startsWith("/oauth/") || path.startsWith("/.well-known/") ? "oauth"
    : path === "/admin" || path.startsWith("/admin/") ? "admin"
    : path.startsWith("/downloads/") ? "downloads" : "other")
}

/** Classify only fixed paths and known RPC method names; never persist request data. */
export function trafficStage(path: string, body: unknown, status: number): TrafficStage {
  if (serviceForPath(path)) {
    // Rejected requests are deliberately not parsed to infer their requested tool.
    if (status === 401 || status === 403) return "mcp_auth"
    if (Array.isArray(body)) return "mcp_batch"
    const method = body && typeof body === "object" ? (body as { method?: unknown }).method : undefined
    switch (method) {
      case "initialize": return "mcp_initialize"
      case "notifications/initialized": return "mcp_initialized"
      case "tools/list": return "mcp_tools_list"
      case "tools/call": return "mcp_tools_call"
      case "ping": return "mcp_ping"
      default: return "mcp_request"
    }
  }
  if (path.startsWith("/.well-known/")) return "oauth_metadata"
  if (path === "/oauth/register") return "oauth_register"
  if (path === "/oauth/token") return "oauth_token"
  if (path === "/oauth/request") return "oauth_par"
  if (path === "/oauth/revoke") return "oauth_revoke"
  if (path === "/oauth/authorize" || path.startsWith("/oauth/authorize/")) return "oauth_authorize"
  if (path.startsWith("/oauth/interaction/")) return "oauth_interaction"
  return path.startsWith("/oauth/") ? "oauth_other" : "other"
}
