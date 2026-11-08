// 비차단 경고 — CLAUDE.md Critical Rules #8: src/tools·src/lib 도구 코드의 console.log/error.
// guard.mjs 가 호출하고, 결과는 hookSpecificOutput.additionalContext 로 Claude 컨텍스트에 들어간다.
// (hookify 경고는 systemMessage 라 모델에 전달되지 않음을 실측해 2026-11 이쪽으로 옮겼다.)

import { readFileSync } from "node:fs"

const SCOPE = /^src\/(?:tools|lib)\/.+\.ts$/
const EXCLUDED = /(?:^|\/)cli-[^/]*\.ts$|\.test\.ts$/
const CONSOLE_CALL = /console\.(?:log|error)\s*\(/g

const count = (text) => (typeof text === "string" ? (text.match(CONSOLE_CALL)?.length ?? 0) : 0)

function readCurrent(absPath) {
  try {
    return readFileSync(absPath, "utf8")
  } catch {
    return ""
  }
}

/** 이번 도구 호출로 console 호출 수가 늘어나는가 (기존 호출을 고치는 편집은 경고하지 않는다). */
function addsConsole(toolName, toolInput, absPath) {
  if (toolName === "Edit") return count(toolInput.new_string) > count(toolInput.old_string)
  if (toolName === "MultiEdit") {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : []
    return edits.reduce((n, e) => n + count(e?.new_string) - count(e?.old_string), 0) > 0
  }
  if (toolName === "Write") return count(toolInput.content) > count(readCurrent(absPath))
  return false
}

export const CONSOLE_WARNING = [
  "[guard] 경고: src/tools·src/lib 코드에 console.log/error 를 추가하고 있습니다 (CLAUDE.md Critical Rules #8).",
  "STDIO 모드 간섭을 막기 위해 도구 코드는 console 출력을 쓰지 않습니다.",
  "- 에러는 throw 로 전파하세요.",
  "- HTTP 모드 에러 로깅은 반드시 scrubError() 를 거치세요 (API 키 유출 방지).",
  "- 정말 필요한 출력이면 사용자에게 이유를 알리고 진행하세요. (CLI 출력 cli.ts·lib/cli-*.ts·setup.ts 는 대상 아님)",
].join("\n")

/** repoPath: 레포 기준 상대경로, absPath: 실제 파일 경로(Write 비교용). 경고 문자열 또는 null. */
export function consoleWarning(input, repoPath, absPath) {
  if (!repoPath || !SCOPE.test(repoPath) || EXCLUDED.test(repoPath)) return null
  return addsConsole(input.tool_name, input.tool_input ?? {}, absPath) ? CONSOLE_WARNING : null
}
