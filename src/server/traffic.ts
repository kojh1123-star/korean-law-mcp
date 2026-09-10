import { serviceForPath } from "./services.js"
export const TRAFFIC_GROUPS = ["law", "g2b", "kosis", "oauth", "admin", "downloads", "health", "other"] as const
export type TrafficGroup = typeof TRAFFIC_GROUPS[number]
export interface TrafficEvent {
  group: TrafficGroup; method: string; status: number; auth: "employee" | "machine" | "anonymous";
  accountId?: string; calls: number;
}
export function trafficGroup(path: string): TrafficGroup {
  return serviceForPath(path) || (path === "/health" || path === "/" ? "health"
    : path.startsWith("/oauth/") || path.startsWith("/.well-known/") ? "oauth"
    : path === "/admin" || path.startsWith("/admin/") ? "admin"
    : path.startsWith("/downloads/") ? "downloads" : "other")
}
