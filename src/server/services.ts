export const SERVICES = {
  law: { name: "법령", path: "/mcp", scope: "law:read" },
  g2b: { name: "나라장터", path: "/g2b/mcp", scope: "g2b:read" },
  kosis: { name: "KOSIS", path: "/kosis/mcp", scope: "kosis:read" },
} as const
export type ServiceId = keyof typeof SERVICES
export const SERVICE_IDS = Object.keys(SERVICES) as ServiceId[]
export const serviceForPath = (path: string): ServiceId | undefined => SERVICE_IDS.find(id => SERVICES[id].path === path)
