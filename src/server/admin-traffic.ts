import type { OAuthStore } from "./oauth-store.js"
import { TRAFFIC_STAGE_LABELS, type TrafficStage } from "./traffic.js"

const names: Record<string, string> = { law: "법령 MCP", g2b: "나라장터 MCP", kosis: "KOSIS MCP", oauth: "로그인·연결 준비", admin: "관리 화면·자동 갱신", health: "서버 상태 확인", downloads: "엑셀 다운로드", other: "기타 요청" }
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!))
const stamp = (v: unknown) => v == null ? "기록 없음" : new Date(Number(v) * 1000).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })

export function trafficHtml(store: OAuthStore, period: "today" | "month" | "all") {
  const snapshot = store.trafficSummary(period), rows = snapshot.rows
  const total = rows.reduce((n, r) => n + Number(r.requests), 0)
  const shared = rows.filter(r => r.auth === "machine").reduce((n, r) => n + Number(r.calls), 0)
  return `<h2>서버에 도착한 요청 · ${{today:"오늘",month:"이번 달",all:"누적 전체"}[period]}</h2>
    <p>집계 시작 ${stamp(snapshot.startedAt)} · 전체 서비스 HTTP 요청 <strong>${total.toLocaleString("ko-KR")}회</strong> · 공용 토큰 도구 호출 <strong>${shared}회</strong></p>
    <p><small>Railway의 CPU·메모리·네트워크 사용량은 서버 자원 지표입니다. 아래는 이 서버가 실제 응답한 HTTP 요청입니다. 연결 준비·인증 실패·상태 확인·관리 화면 갱신도 포함되며, 직원별 조회 횟수와는 집계 범위가 다릅니다. 새 요청 집계 이전의 기록은 소급하지 않습니다.</small></p>
    <div class="scroll"><table aria-label="서버 요청 분류"><thead><tr><th>요청 종류</th><th>전체 HTTP</th><th>인증 필요·거절(401/403)</th><th>HTTP 오류(4xx/5xx)</th><th>직원 도구 호출</th><th>공용 토큰 도구 호출</th><th>최근 응답</th></tr></thead><tbody>${Object.entries(names).map(([id, label]) => {
      const category = rows.filter(r => r.category === id), sum = (key: string) => category.reduce((n, r) => n + Number(r[key]), 0)
      const calls = (auth: string) => category.filter(r => r.auth === auth).reduce((n, r) => n + Number(r.calls), 0)
      return `<tr><td>${label}</td><td>${sum("requests")}회</td><td>${sum("denied")}회</td><td>${sum("errors")}회</td><td>${calls("employee")}회</td><td>${calls("machine")}회</td><td>${category.length ? stamp(Math.max(...category.map(r => Number(r.last_at)))) : "기록 없음"}</td></tr>`
    }).join("")}</tbody></table></div>
    <p><small>401은 OAuth 연결을 시작할 때도 정상적으로 발생합니다. 공용 토큰에는 직원 신원이 없으므로 직원 비율에 임의로 배분하지 않습니다. 직원별 집계에는 개인 OAuth 로그인이 필요합니다.</small></p>
    <h2>최근 MCP·로그인 요청</h2><p><small>최근 30건 · 최대 100건 보관 · 요청 내용·인증키·IP는 저장하지 않습니다. 계정은 인증에 성공한 요청만 표시합니다.</small></p>
    <p><small>도구 목록 수신까지 진행됐는지 실제 요청 단계로 확인하세요. ‘도구 목록’ 요청과 HTTP 응답 코드를 함께 확인하고, ChatGPT·Claude 내부 설치 완료 여부는 해당 앱에서 확인해주세요. 단계 표시 이전 요청은 ‘이전 기록’으로 표시합니다.</small></p>
    <div class="scroll"><table aria-label="최근 MCP 요청"><thead><tr><th>시각</th><th>종류</th><th>요청 단계</th><th>방식</th><th>응답 코드</th><th>확인된 계정</th><th>도구 호출</th></tr></thead><tbody>${snapshot.recent.map(r => `<tr><td>${stamp(r.at)}</td><td>${names[String(r.category)] || "기타"}</td><td>${esc(TRAFFIC_STAGE_LABELS[String(r.stage) as TrafficStage] || TRAFFIC_STAGE_LABELS.legacy)}</td><td>${esc(r.method)}</td><td>${Number(r.status)}</td><td>${r.auth === "employee" ? esc(r.account_id) : r.auth === "machine" ? "공용 토큰" : "직원 인증 전"}</td><td>${Number(r.calls)}회</td></tr>`).join("") || '<tr><td colspan="7">아직 요청이 없습니다.</td></tr>'}</tbody></table></div>`
}
