#!/usr/bin/env node
// PreToolUse 가드 — CLAUDE.md 의 "절대 금지" 규칙을 모델의 기억이 아니라 시스템이 강제한다.
// 등록: .claude/settings.json (hooks.PreToolUse). 플러그인 없이 이 레포를 여는 모든 Claude Code 환경에서 동작.
//
// 1) LexDiff 이식 파일 수정 차단 (Critical Rules #1) — Edit/Write/MultiEdit + 흔한 Bash 쓰기 형태
// 2) 이 레포에서 `fly deploy` 실행 차단 (배포 절) — gomdori-mcp 안에서 실행할 때만 허용
//
// 차단 = exit 2 + stderr(Claude 에게 차단 사유로 전달). 그 밖의 모든 경우(입력 파싱 실패 포함) exit 0 = 통과.
// Bash 검사는 휴리스틱이다: node -e / 스크립트 파일 경유 쓰기, git checkout·apply 등은 잡지 않는다.

import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const PROTECTED_FILES = [
  "src/lib/search-normalizer.ts",
  "src/lib/law-parser.ts",
  "src/lib/citation-content-matcher.ts",
]

// 사용자 승인 후에만 만드는 일시 해제 파일(.gitignore 대상). mtime 기준 1시간 유효.
export const OVERRIDE_FILE = ".claude/hooks/.allow-protected-edit"
const OVERRIDE_TTL_MS = 60 * 60 * 1000

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit"])

/** 경로를 레포 기준 상대경로(`/` 구분)로. 레포 밖이면 null. */
function toRepoPath(target, cwd, root) {
  if (typeof target !== "string" || target === "") return null
  const rel = path.relative(root, path.resolve(cwd, target))
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join("/")
}

function isProtected(target, cwd, root) {
  const rel = toRepoPath(stripQuotes(target), cwd, root)
  return rel !== null && PROTECTED_FILES.includes(rel)
}

function stripQuotes(token) {
  return String(token).replace(/^["']+|["']+$/g, "")
}

function overrideActive(root, now) {
  try {
    const { mtimeMs } = statSync(path.join(root, OVERRIDE_FILE))
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
  "통합 이미지가 law 단독 이미지로 덮여 stats·patent·archhub·school 까지 함께 중단됩니다.",
  "배포·롤백은 gomdori-mcp 에서만: cd ~/workspace/gomdori-mcp && fly deploy -c fly.production.toml",
].join("\n")

function checkFileTool(input, root, now) {
  const filePath = input.tool_input?.file_path
  const cwd = input.cwd || root
  if (!isProtected(filePath, cwd, root) || overrideActive(root, now)) return null
  return protectedMessage(toRepoPath(filePath, cwd, root))
}

/** 따옴표 밖의 `;` `|` `||` `&&` 줄바꿈 기준으로 명령을 조각낸다. */
export function splitSegments(command) {
  const segments = []
  let current = ""
  let quote = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) quote = null
      current += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
    } else if (ch === ";" || ch === "\n" || ch === "|" || (ch === "&" && command[i + 1] === "&")) {
      segments.push(current)
      current = ""
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++
    } else {
      current += ch
    }
  }
  segments.push(current)
  return segments
}

/** 조각의 실제 명령어(맨 앞 sudo·환경변수 대입·여는 괄호 제외)와 인자. */
function commandOf(segment) {
  const tokens = segment.trim().replace(/^\(+/, "").split(/\s+/).filter(Boolean)
  while (tokens[0] === "sudo" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) tokens.shift()
  const [cmd = "", ...args] = tokens
  return { cmd: path.basename(cmd), args }
}

/** `fly deploy` / `flyctl deploy` — gomdori-mcp 를 cwd 로 쓰거나 그리로 cd 한 명령만 허용. */
function checkFlyDeploy(segments, command, cwd) {
  const deploys = segments.some((s) => {
    const { cmd, args } = commandOf(s)
    return (cmd === "fly" || cmd === "flyctl") && args.includes("deploy")
  })
  if (!deploys) return null
  const inGomdori = /gomdori-mcp/.test(cwd) || /\bcd\s+[^;&|\n]*gomdori-mcp/.test(command)
  return inGomdori ? null : FLY_MESSAGE
}

const IN_PLACE_EDITORS = /^(?:sed|perl)$/
const ALWAYS_WRITES = /^(?:rm|mv|truncate|shred|patch|tee)$/
const DEST_LAST = /^(?:cp|install|rsync)$/

/** 리다이렉트(`>` `>>`) 대상. `> "경로"` 는 살리고, 그 밖의 따옴표 문자열은 지워 오탐을 막는다. */
function redirectTargets(segment) {
  const unquoted = segment.replace(/(>{1,2}\s*)?('[^']*'|"[^"]*")/g, (m, redirect) => (redirect ? m : ""))
  return [...unquoted.matchAll(/(?:^|[^0-9&>])>{1,2}\s*("[^"]*"|'[^']*'|[^\s<>|;&]+)/g)].map((m) => m[1])
}

/** Bash 명령 한 조각이 보호 파일에 쓰는지 (휴리스틱). */
function segmentWritesProtected(segment, cwd, root) {
  if (redirectTargets(segment).some((t) => isProtected(t, cwd, root))) return true
  const { cmd, args } = commandOf(segment)
  if (!args.some((a) => isProtected(a, cwd, root))) return false
  if (IN_PLACE_EDITORS.test(cmd)) return args.some((a) => /^(?:-[A-Za-z]*i|--in-place)/.test(a))
  if (ALWAYS_WRITES.test(cmd)) return true
  if (DEST_LAST.test(cmd)) return isProtected(args[args.length - 1], cwd, root)
  return false
}

function checkBash(input, root, now) {
  const command = String(input.tool_input?.command ?? "")
  const cwd = input.cwd || root
  const segments = splitSegments(command)
  const fly = checkFlyDeploy(segments, command, cwd)
  if (fly) return fly
  if (overrideActive(root, now)) return null
  for (const segment of segments) {
    if (segmentWritesProtected(segment, cwd, root)) {
      const hit = PROTECTED_FILES.find((f) => segment.includes(path.basename(f))) ?? "보호 파일"
      return protectedMessage(hit)
    }
  }
  return null
}

/** 훅 입력 → 차단 사유(문자열) 또는 null(통과). 테스트에서 직접 호출한다. */
export function evaluate(input, { root, now = Date.now() } = {}) {
  if (!input || typeof input !== "object") return null
  const projectRoot = root || process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
  if (FILE_TOOLS.has(input.tool_name)) return checkFileTool(input, projectRoot, now)
  if (input.tool_name === "Bash") return checkBash(input, projectRoot, now)
  return null
}

function main() {
  let input
  try {
    input = JSON.parse(readFileSync(0, "utf8"))
  } catch {
    process.exit(0)
  }
  const reason = evaluate(input)
  if (reason) {
    process.stderr.write(`${reason}\n`)
    process.exit(2)
  }
  process.exit(0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
