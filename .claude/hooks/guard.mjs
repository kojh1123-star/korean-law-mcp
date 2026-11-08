#!/usr/bin/env node
// PreToolUse 가드 진입점 — CLAUDE.md 규칙을 모델 기억 대신 시스템이 강제한다.
// 등록: .claude/settings.json (exec form: node + args, 셸을 거치지 않아 Windows·macOS·Linux 공통). 플러그인 불필요.
// 판정 로직은 guard-rules.mjs, 회귀 테스트는 guard.test.mjs (node --test .claude/hooks/guard.test.mjs).
//
// 차단 = exit 2 + stderr(Claude 에게 차단 사유). 경고 = exit 0 + stdout JSON additionalContext.
// 그 밖의 모든 경우(입력 파싱 실패 포함) exit 0 = 통과.
// process.exit() 대신 exitCode — macOS 파이프는 비동기 쓰기라 즉시 종료하면 메시지가 잘릴 수 있다.

import { readFileSync } from "node:fs"
import { evaluate, advise } from "./guard-rules.mjs"

function main() {
  let input
  try {
    input = JSON.parse(readFileSync(0, "utf8"))
  } catch {
    return
  }
  const reason = evaluate(input)
  if (reason) {
    process.stderr.write(`${reason}\n`)
    process.exitCode = 2
    return
  }
  const warning = advise(input)
  if (warning) {
    const output = { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: warning } }
    process.stdout.write(JSON.stringify(output))
  }
}

main()
