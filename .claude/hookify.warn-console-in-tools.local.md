---
name: warn-console-in-tools
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: src/(tools|lib)/.*\.ts$
  - field: file_path
    operator: not_contains
    pattern: /cli-
  - field: file_path
    operator: not_contains
    pattern: .test.ts
  - field: content
    operator: regex_match
    pattern: console\.(log|error)\(
---

⚠️ **console.log/error 감지** — CLAUDE.md Critical Rules #8

`src/tools`·`src/lib` 도구 코드는 STDIO 모드 간섭을 막기 위해 console 출력을 쓰지 않습니다.

- 에러는 `throw`로 전파하세요.
- HTTP 모드 에러 로깅은 반드시 `scrubError()`를 거치세요 (API 키 유출 방지).
- CLI 출력(`src/cli.ts`, `src/lib/cli-*.ts`)과 `src/setup.ts`는 이 경고 대상이 아닙니다.
