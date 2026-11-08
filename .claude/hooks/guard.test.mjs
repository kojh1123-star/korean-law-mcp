// 가드 훅 회귀 테스트 — 실행: node --test .claude/hooks/guard.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { evaluate, advise, OVERRIDE_FILE } from "./guard-rules.mjs"
import { splitSegments } from "./shell-rules.mjs"

const root = mkdtempSync(path.join(tmpdir(), "guard-"))
const bash = (command, cwd = root) => evaluate({ tool_name: "Bash", tool_input: { command }, cwd }, { root })
const ps = (command, cwd = root) => evaluate({ tool_name: "PowerShell", tool_input: { command }, cwd }, { root })
const edit = (file_path, tool_name = "Edit") => evaluate({ tool_name, tool_input: { file_path }, cwd: root }, { root })
const warn = (tool_name, tool_input) => advise({ tool_name, tool_input, cwd: root }, { root })
const addLog = (file_path) => ({ file_path, old_string: "a", new_string: "console.log(a)" })

test("LexDiff 이식 파일 Edit/Write/MultiEdit 차단", () => {
  assert.match(edit(path.join(root, "src/lib/law-parser.ts")), /LexDiff/)
  assert.match(edit("src/lib/search-normalizer.ts", "Write"), /LexDiff/)
  assert.match(edit("src/lib/citation-content-matcher.ts", "MultiEdit"), /LexDiff/)
})

test("일반 파일과 레포 밖 동명 파일은 통과", () => {
  assert.equal(edit("src/lib/query-router.ts"), null)
  assert.equal(edit("src/lib/law-parser.test.ts"), null)
  assert.equal(edit("/tmp/lexdiff/src/lib/law-parser.ts"), null)
})

test("Bash 쓰기 형태 차단", () => {
  assert.match(bash("sed -i 's/a|b/c/' src/lib/law-parser.ts"), /LexDiff/)
  assert.match(bash("perl -pi -e 's/x/y/' src/lib/law-parser.ts"), /LexDiff/)
  assert.match(bash("cat tmp.ts > src/lib/law-parser.ts"), /LexDiff/)
  assert.match(bash('echo x >> "src/lib/search-normalizer.ts"'), /LexDiff/)
  assert.match(bash("echo x | tee src/lib/law-parser.ts"), /LexDiff/)
  assert.match(bash("cp /tmp/new.ts src/lib/law-parser.ts"), /LexDiff/)
  assert.match(bash("rm src/lib/citation-content-matcher.ts"), /LexDiff/)
  assert.match(bash("sed -i '' lib/law-parser.ts", path.join(root, "src")), /LexDiff/)
})

test("Bash 읽기 형태는 통과", () => {
  assert.equal(bash("cat src/lib/law-parser.ts"), null)
  assert.equal(bash("sed -n 1,20p src/lib/law-parser.ts"), null)
  assert.equal(bash("cp src/lib/law-parser.ts /tmp/x.ts"), null)
  assert.equal(bash("diff src/lib/law-parser.ts /tmp/lexdiff/law-parser.ts"), null)
  assert.equal(bash('grep -n "> src/lib/law-parser.ts" CLAUDE.md'), null)
  assert.equal(bash("git diff src/lib/law-parser.ts 2>&1 | head"), null)
})

test("fly deploy: 이 레포에서는 차단, gomdori-mcp 에서는 통과", () => {
  assert.match(bash("fly deploy"), /fly deploy/)
  assert.match(bash("flyctl deploy -a korean-law-mcp -i registry/img"), /fly deploy/)
  assert.match(bash("npm run build && fly deploy"), /fly deploy/)
  assert.equal(bash("cd ~/workspace/gomdori-mcp && fly deploy -c fly.production.toml"), null)
  assert.equal(bash("fly deploy -c fly.production.toml", "/home/u/workspace/gomdori-mcp"), null)
})

test("fly 문자열을 검색·출력만 하는 명령은 통과", () => {
  assert.equal(bash('grep -rn "fly deploy" docs/'), null)
  assert.equal(bash("fly releases -a korean-law-mcp"), null)
  assert.equal(bash("echo 'fly deploy 금지'"), null)
})

test("PowerShell 쓰기 형태 차단 (Windows 에서 Claude 의 주 셸)", () => {
  assert.match(ps("Set-Content -Path src/lib/law-parser.ts -Value x"), /LexDiff/)
  assert.match(ps("'x' | Out-File src\\lib\\law-parser.ts"), /LexDiff/)
  assert.match(ps("Copy-Item C:/tmp/new.ts -Destination src/lib/search-normalizer.ts"), /LexDiff/)
  assert.match(ps("Remove-Item src/lib/citation-content-matcher.ts"), /LexDiff/)
  assert.match(ps("[IO.File]::WriteAllText('src/lib/law-parser.ts', 'x')"), /LexDiff/)
  assert.match(ps("echo x > src/lib/law-parser.ts"), /LexDiff/)
})

test("PowerShell 읽기 형태는 통과", () => {
  assert.equal(ps("Get-Content src/lib/law-parser.ts"), null)
  assert.equal(ps("Copy-Item src/lib/law-parser.ts -Destination C:/tmp/x.ts"), null)
  assert.equal(ps("Select-String -Path src/lib/law-parser.ts -Pattern jo"), null)
  assert.equal(ps('Select-String "fly deploy" CLAUDE.md'), null)
})

test("PowerShell fly deploy: 호출 연산자·.exe 포함 차단, gomdori-mcp 이동 후 통과", () => {
  assert.match(ps("fly deploy"), /fly deploy/)
  assert.match(ps("& fly deploy"), /fly deploy/)
  assert.match(ps("flyctl.exe deploy -a korean-law-mcp"), /fly deploy/)
  assert.equal(ps("Set-Location ~/workspace/gomdori-mcp; fly deploy -c fly.production.toml"), null)
})

test("Windows 경로: 역슬래시·드라이브 문자 대소문자와 무관하게 판정", () => {
  const winRoot = "C:\\work\\korean-law-mcp"
  const winEdit = (file_path) => evaluate({ tool_name: "Edit", tool_input: { file_path }, cwd: winRoot }, { root: winRoot })
  assert.match(winEdit("C:\\work\\korean-law-mcp\\src\\lib\\law-parser.ts"), /LexDiff/)
  assert.match(winEdit("c:\\WORK\\Korean-Law-MCP\\src\\lib\\law-parser.ts"), /LexDiff/)
  assert.match(winEdit("src/lib/search-normalizer.ts"), /LexDiff/)
  assert.equal(winEdit("C:\\work\\korean-law-mcp\\src\\lib\\query-router.ts"), null)
  assert.equal(winEdit("D:\\other\\src\\lib\\law-parser.ts"), null)
  const winPs = (command) => evaluate({ tool_name: "PowerShell", tool_input: { command }, cwd: winRoot }, { root: winRoot })
  assert.match(winPs("Set-Content src\\lib\\law-parser.ts x"), /LexDiff/)
  assert.match(winPs("fly deploy"), /fly deploy/)
  const gomdori = "C:\\Users\\me\\workspace\\gomdori-mcp"
  const inGomdori = evaluate({ tool_name: "PowerShell", tool_input: { command: "fly deploy" }, cwd: gomdori }, { root: winRoot })
  assert.equal(inGomdori, null)
})

test("진입점(guard.mjs): stdin → 종료 코드·출력 계약", () => {
  const entry = fileURLToPath(new URL("./guard.mjs", import.meta.url))
  const run = (payload) => spawnSync(process.execPath, [entry], { input: payload, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } })
  const blocked = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "fly deploy" }, cwd: root }))
  assert.equal(blocked.status, 2)
  assert.match(blocked.stderr, /fly deploy/)
  const warned = run(JSON.stringify({ tool_name: "Edit", tool_input: addLog(path.join(root, "src/tools/x.ts")), cwd: root }))
  assert.equal(warned.status, 0)
  assert.match(JSON.parse(warned.stdout).hookSpecificOutput.additionalContext, /#8/)
  assert.equal(run("not json").status, 0)
  assert.equal(run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: root })).stdout, "")
})

test("승인 해제 파일: 1시간 안에는 LexDiff 차단 해제, fly deploy 는 계속 차단", () => {
  mkdirSync(path.join(root, path.dirname(OVERRIDE_FILE)), { recursive: true })
  const override = path.join(root, OVERRIDE_FILE)
  writeFileSync(override, "사용자 승인: 상류 대조 완료")
  assert.equal(edit("src/lib/law-parser.ts"), null)
  assert.equal(bash("sed -i 's/a/b/' src/lib/law-parser.ts"), null)
  assert.match(bash("fly deploy"), /fly deploy/)
  const stale = (Date.now() - 2 * 60 * 60 * 1000) / 1000
  utimesSync(override, stale, stale)
  assert.match(edit("src/lib/law-parser.ts"), /LexDiff/)
})

test("splitSegments 는 따옴표 안 구분자를 무시", () => {
  assert.deepEqual(splitSegments("a 'x|y;z' && b || c; d | e"), ["a 'x|y;z' ", " b ", " c", " d ", " e"])
})

test("입력이 비정상이면 통과", () => {
  assert.equal(evaluate(null, { root }), null)
  assert.equal(evaluate({ tool_name: "Read", tool_input: { file_path: "src/lib/law-parser.ts" } }, { root }), null)
  assert.equal(evaluate({ tool_name: "Edit", tool_input: {} }, { root }), null)
  assert.equal(advise(null, { root }), null)
  assert.equal(advise({ tool_name: "Bash", tool_input: { command: "echo console.log(1)" } }, { root }), null)
})

test("console 경고: src/tools·src/lib 에 console 을 추가하면 경고만 하고 차단하지 않는다", () => {
  assert.match(warn("Edit", addLog("src/tools/law-text.ts")), /Critical Rules #8/)
  assert.match(warn("Write", { file_path: "src/tools/scenarios/new.ts", content: "console.error(e)" }), /#8/)
  const multi = { file_path: "src/lib/cache.ts", edits: [{ old_string: "a", new_string: "console.log(a)" }] }
  assert.match(warn("MultiEdit", multi), /#8/)
  assert.equal(evaluate({ tool_name: "Edit", tool_input: addLog("src/tools/law-text.ts"), cwd: root }, { root }), null)
})

test("console 경고 제외: 기존 호출 수정, CLI·setup·테스트·범위 밖 파일", () => {
  const rewrite = { file_path: "src/tools/law-text.ts", old_string: "console.log(a)", new_string: "console.log(b)" }
  assert.equal(warn("Edit", rewrite), null)
  assert.equal(warn("Edit", addLog("src/lib/cli-format.ts")), null)
  assert.equal(warn("Edit", addLog("src/cli.ts")), null)
  assert.equal(warn("Edit", addLog("src/setup.ts")), null)
  assert.equal(warn("Edit", addLog("src/lib/foo.test.ts")), null)
  assert.equal(warn("Edit", addLog("scripts/x.ts")), null)
})

test("console 경고: Write 는 기존 파일보다 호출 수가 늘 때만", () => {
  mkdirSync(path.join(root, "src/lib"), { recursive: true })
  writeFileSync(path.join(root, "src/lib/existing.ts"), "console.error(x)\n")
  const write = (content) => warn("Write", { file_path: "src/lib/existing.ts", content })
  assert.equal(write("console.error(x)\nconst y = 1\n"), null)
  assert.match(write("console.error(x)\nconsole.log(y)\n"), /#8/)
})
