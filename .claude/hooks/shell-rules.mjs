// 셸 명령(Bash·PowerShell) 분석 — guard-rules.mjs 가 쓴다. 경로 판정은 isProtected 콜백으로 주입받는다.
// Windows 에서 Claude 는 PowerShell 도구를 주 셸로 쓰므로 두 문법을 함께 본다(대소문자 무시). 휴리스틱이다.

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

/** 조각의 실제 명령어(소문자, 경로·.exe 제거)와 인자. 맨 앞 `(` `&`(PowerShell 호출 연산자)·sudo·환경변수 대입은 건너뛴다. */
export function commandOf(segment) {
  const tokens = segment.trim().replace(/^\(+/, "").split(/\s+/).filter(Boolean)
  while (["sudo", "&"].includes(tokens[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) tokens.shift()
  const [raw = "", ...args] = tokens
  const cmd = raw.replace(/\\/g, "/").split("/").pop().replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase()
  return { cmd, args }
}

const CD = /(?:^|[\s;&|(])(?:cd|set-location|sl|pushd|push-location)\s+[^;&|\n]*gomdori-mcp/i

/** `fly deploy` / `flyctl deploy` 가 gomdori-mcp 밖에서 실행되는가. */
export function isForbiddenFlyDeploy(segments, command, cwd) {
  const deploys = segments.some((s) => {
    const { cmd, args } = commandOf(s)
    return (cmd === "fly" || cmd === "flyctl") && args.some((a) => a.toLowerCase() === "deploy")
  })
  return deploys && !/gomdori-mcp/i.test(cwd) && !CD.test(command)
}

// 대상 경로 인자가 하나라도 보호 파일이면 쓰기로 보는 명령 (Bash + PowerShell cmdlet·별칭)
const WRITES = new Set([
  "rm", "mv", "truncate", "shred", "patch", "tee",
  "set-content", "add-content", "clear-content", "out-file", "tee-object", "new-item", "ni",
  "remove-item", "ri", "del", "erase", "rd", "rmdir", "move-item", "mi", "move", "ac", "sc",
])
// 마지막 위치 인자(또는 -Destination 값)가 대상인 복사 명령
const COPIES = new Set(["cp", "install", "rsync", "copy-item", "copy", "cpi"])
const IN_PLACE = new Set(["sed", "perl"])

/** 리다이렉트(`>` `>>`) 대상. `> "경로"` 는 살리고, 그 밖의 따옴표 문자열은 지워 오탐을 막는다. */
function redirectTargets(segment) {
  const unquoted = segment.replace(/(>{1,2}\s*)?('[^']*'|"[^"]*")/g, (m, redirect) => (redirect ? m : ""))
  return [...unquoted.matchAll(/(?:^|[^0-9&>])>{1,2}\s*("[^"]*"|'[^']*'|[^\s<>|;&]+)/g)].map((m) => m[1])
}

function copyDestination(args) {
  const flag = args.findIndex((a) => /^-destination$/i.test(a))
  if (flag >= 0) return args[flag + 1]
  return args.filter((a) => !a.startsWith("-")).pop()
}

/** 조각 하나가 보호 파일에 쓰는지. */
function segmentWrites(segment, isProtected) {
  if (redirectTargets(segment).some(isProtected)) return true
  // PowerShell 에서 .NET 직접 쓰기: [IO.File]::WriteAllText('경로', ...)
  if (/\[(?:system\.)?io\.file\]::(?:write|append)/i.test(segment)) {
    return [...segment.matchAll(/'([^']*)'|"([^"]*)"/g)].some((m) => isProtected(m[1] ?? m[2]))
  }
  const { cmd, args } = commandOf(segment)
  if (!args.some(isProtected)) return false
  if (IN_PLACE.has(cmd)) return args.some((a) => /^(?:-[A-Za-z]*i|--in-place)/.test(a))
  if (WRITES.has(cmd)) return true
  if (COPIES.has(cmd)) return isProtected(copyDestination(args))
  return false
}

/** 보호 파일에 쓰는 첫 조각을 돌려준다. 없으면 null. */
export function findProtectedWrite(segments, isProtected) {
  return segments.find((s) => segmentWrites(s, isProtected)) ?? null
}
