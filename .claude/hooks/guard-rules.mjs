// 가드 판정 로직 — guard.mjs(훅 진입점)와 guard.test.mjs 가 쓴다.
// 1) LexDiff 이식 파일 수정 차단 (CLAUDE.md Critical Rules #1) — 파일 도구 + Bash·PowerShell 쓰기 형태
// 2) 이 레포에서 `fly deploy` 실행 차단 (CLAUDE.md 배포 절) — gomdori-mcp 안에서만 통과
// 3) src/tools·src/lib 의 console 추가 경고 (Critical Rules #8, 비차단) — console-warning.mjs

import { statSync } from "node:fs"
import path from "node:path"
import { consoleWarning } from "./console-warning.mjs"
import { splitSegments, isForbiddenFlyDeploy, findProtectedWrite } from "./shell-rules.mjs"

export const PROTECTED_FILES = [
  "src/lib/search-normalizer.ts",
  "src/lib/law-parser.ts",
  "src/lib/citation-content-matcher.ts",
]

// 사용자 승인 후에만 만드는 일시 해제 파일(.gitignore 대상). mtime 기준 1시간 유효.
export const OVERRIDE_FILE = ".claude/hooks/.allow-protected-edit"
const OVERRIDE_TTL_MS = 60 * 60 * 1000

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit"])
const SHELL_TOOLS = new Set(["Bash", "PowerShell"])

// 드라이브 문자 경로면 win32 규칙(역슬래시·대소문자 무시)으로 비교한다 — Windows 실행 + 테스트 겸용.
const pathApi = (root) => (/^[A-Za-z]:[\\/]/.test(root) ? path.win32 : path.posix)
const stripQuotes = (token) => String(token).replace(/^["']+|["']+$/g, "")

/** 경로를 레포 기준 상대경로(`/` 구분)로. 레포 밖이면 null. */
function toRepoPath(target, cwd, root) {
  if (typeof target !== "string" || target === "") return null
  const p = pathApi(root)
  const raw = stripQuotes(target)
  // PowerShell 은 macOS·Linux 에서도 `\` 를 경로 구분자로 받는다
  const normalized = p === path.posix ? raw.replace(/\\/g, "/") : raw
  const rel = p.relative(root, p.resolve(cwd, normalized))
  if (rel === "" || rel.startsWith("..") || p.isAbsolute(rel)) return null
  return rel.split(p.sep).join("/")
}

/** 보호 파일이면 그 레포 경로(원래 표기), 아니면 null. win32 비교는 대소문자를 무시한다. */
function protectedPath(target, cwd, root) {
  const rel = toRepoPath(target, cwd, root)
  if (rel === null) return null
  const key = pathApi(root) === path.win32 ? rel.toLowerCase() : rel
  return PROTECTED_FILES.find((f) => (pathApi(root) === path.win32 ? f.toLowerCase() : f) === key) ?? null
}

function overrideActive(root, now) {
  try {
    const { mtimeMs } = statSync(pathApi(root).join(root, OVERRIDE_FILE))
    return now - mtimeMs < OVERRIDE_TTL_MS
  } catch {
    return false
  }
}

function protectedMessage(rel) {
  return [
    `[guard] 차단: ${rel} 는 LexDiff 이식 코드입니다 (CLAUDE.md Critical Rules #1).`,
    "상류(LexDiff) 원본 대조 없이 수정하지 않습니다.",
    "- 수정이 꼭 필요하면 작업을 멈추고, 사용자에게 사유를 설명해 명시적 승인을 받으세요.",
    `- 승인을 받은 경우에만 ${OVERRIDE_FILE} 파일(내용: 승인 사유)을 만들면 1시간 동안 해제됩니다. 작업이 끝나면 삭제하세요.`,
  ].join("\n")
}

const FLY_MESSAGE = [
  "[guard] 차단: 이 레포(korean-law-mcp)에서는 fly deploy 를 실행하지 않습니다 (CLAUDE.md 배포 절).",
  "원작자 운영 기준으로 이 레포에서 배포하면 통합 이미지가 law 단독 이미지로 덮여 다른 서비스까지 중단됩니다.",
  "배포가 필요해 보이면 실행하지 말고 사용자에게 먼저 확인하세요.",
].join("\n")

function checkFileTool(input, root, now) {
  const cwd = input.cwd || root
  const hit = protectedPath(input.tool_input?.file_path, cwd, root)
  return hit && !overrideActive(root, now) ? protectedMessage(hit) : null
}

function checkShell(input, root, now) {
  const command = String(input.tool_input?.command ?? "")
  const cwd = input.cwd || root
  const segments = splitSegments(command)
  if (isForbiddenFlyDeploy(segments, command, cwd)) return FLY_MESSAGE
  if (overrideActive(root, now)) return null
  let hit = null
  const isProtected = (target) => {
    const found = protectedPath(target, cwd, root)
    if (found) hit = found
    return found !== null
  }
  return findProtectedWrite(segments, isProtected) ? protectedMessage(hit) : null
}

const resolveRoot = (input, root) => root || process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()

/** 훅 입력 → 차단 사유(문자열) 또는 null(통과). */
export function evaluate(input, { root, now = Date.now() } = {}) {
  if (!input || typeof input !== "object") return null
  const projectRoot = resolveRoot(input, root)
  if (FILE_TOOLS.has(input.tool_name)) return checkFileTool(input, projectRoot, now)
  if (SHELL_TOOLS.has(input.tool_name)) return checkShell(input, projectRoot, now)
  return null
}

/** 훅 입력 → Claude 에게 줄 비차단 경고(문자열) 또는 null. */
export function advise(input, { root } = {}) {
  if (!input || typeof input !== "object" || !FILE_TOOLS.has(input.tool_name)) return null
  const projectRoot = resolveRoot(input, root)
  const cwd = input.cwd || projectRoot
  const filePath = input.tool_input?.file_path
  const repoPath = toRepoPath(filePath, cwd, projectRoot)
  return repoPath ? consoleWarning(input, repoPath, pathApi(projectRoot).resolve(cwd, filePath)) : null
}
