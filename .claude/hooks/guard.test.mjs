// guard.mjs 회귀 테스트 — 실행: node --test .claude/hooks/guard.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { evaluate, splitSegments, OVERRIDE_FILE } from "./guard.mjs"

const root = mkdtempSync(path.join(tmpdir(), "guard-"))
const bash = (command, cwd = root) => evaluate({ tool_name: "Bash", tool_input: { command }, cwd }, { root })
const edit = (file_path, tool_name = "Edit") => evaluate({ tool_name, tool_input: { file_path }, cwd: root }, { root })

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
})
