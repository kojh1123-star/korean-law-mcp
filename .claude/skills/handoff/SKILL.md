---
name: handoff
description: Save, resume, or close a cross-session handoff for this repo in cloud Claude Code sessions. Writes .claude/handoff.md (done / remaining / next step / how to verify / in-flight state), commits and pushes it, and on resume verifies it against the real repo before continuing. Use this whenever the user says 인계, 핸드오프, handoff, 세션 넘기기, 다음 세션에서 이어서, 인계 파일 읽고 이어가, 이어서 진행, resume, pick up where we left off, or names a ccr-* branch to continue from — and also when a large multi-PR task reaches a milestone or the conversation has been auto-summarized, even if the user did not ask for a handoff by name.
---

# Session handoff (cloud sessions)

This repo is worked on from claude.ai cloud sessions. Each session runs in an
ephemeral container on its own `ccr-*` branch cut from `main`, and the container
is reclaimed when the session ends. So a handoff only survives if it is
**committed and pushed**, and the next session will only see it if it
**fetches the branch it lives on**. The handoff file is a claim; the repo is
the truth — the next session verifies before it continues.

Pick the mode from the request:

| Mode | When | Result |
|---|---|---|
| Save | "인계해줘", milestone reached, session getting long | `.claude/handoff.md` pushed + a resume line for the user |
| Resume | "인계 파일 읽고 이어가", a ccr-* branch named | work merged onto this session's branch, verified, then continued |
| Close | the whole task is done | handoff file removed so it never reaches `main` |

Reply to the user in Korean. Write the handoff file itself in Korean so the
user can read it on their phone.

## Environment facts that shape the steps

- Only pushed commits survive. `node_modules/`, `build/`, background processes,
  and anything under `~/.claude` disappear with the container.
- `.claude/plans/` and `.claude/memory/` are gitignored — never put the handoff
  there; it would be silently lost.
- `.claude/next-sessions.md` is an old upstream note from the v2.2 era. It is
  not a handoff for current work. Ignore it on resume, and never follow its
  `fly deploy` step (CLAUDE.md forbids `fly deploy` from this repo).
- Husky hooks are usually inactive in a fresh container (no `node_modules`, no
  `core.hooksPath`), so nothing scans for secrets on commit. The handoff file is
  pushed to GitHub: you are the secret check.
- PR subscriptions and `send_later` check-ins belong to the session that made
  them. They do not move to the next session.

## Save

1. **Reach a checkpoint.** Prefer a state where typecheck and tests pass. If
   you are mid-edit, finish the small step or write down exactly what is
   half-done and which file is affected. A vague "WIP" costs the next session
   more than finishing the edit would.
2. **Collect facts from commands, not memory.**
   - `git status --short`, `git branch --show-current`, `git rev-parse --short HEAD`
   - `git log --oneline origin/main..HEAD` (what this branch adds)
   - Open PR for this branch and its CI state (GitHub MCP tools), if any
   - Verification results: if `node_modules` is missing run
     `npm ci --ignore-scripts`, then `npm run typecheck` and `npm test`.
     Record actual counts. If you skipped a check, write "미실행", not "통과".
   - Time: `TZ=Asia/Seoul date '+%Y-%m-%d %H:%M KST'`
3. **Write `.claude/handoff.md`** with the template below. Overwrite any
   previous handoff on this branch — one current file, not a history. Keep it
   under ~80 lines; link commits instead of pasting diffs.
4. **Secret and privacy check.** Never write credential values (`LAW_OC`,
   `MCP_AUTH_TOKEN`, OAuth client secrets, admin or employee passwords, API
   keys) or personal data (employee names, IDs, emails) into the file. Env var
   *names* are fine. Run
   `grep -nEi 'key|secret|token|password|passwd|bearer|@[a-z0-9.-]+\.[a-z]{2,}' .claude/handoff.md`
   and inspect every hit.
5. **Commit and push.** Stage the work files you intend to keep plus
   `.claude/handoff.md` by name (check `git status` for strays; do not
   `git add -A` blindly). Commit as
   `chore(handoff): 세션 인계 — <one line>`, then
   `git push -u origin <current-branch>` (retry on network errors only).
6. **Prove it is on the remote:**
   `git fetch origin <branch> && git show origin/<branch>:.claude/handoff.md | head -5`.
   If this fails, the handoff does not exist yet — fix it before telling the
   user anything.
7. **Tell the user** (Korean, short): branch, HEAD sha, what is in flight, and
   a copy-paste line for the next session:
   > `<branch>` 브랜치의 .claude/handoff.md 읽고 검증한 다음 이어서 진행해줘

   If this session holds a PR subscription or scheduled check-ins, say so —
   they stop working for this task once the user moves on.

## Resume

1. **Locate the handoff.**
   - User named a branch → use it.
   - `.claude/handoff.md` already in the working tree → use it.
   - Otherwise run `bash .claude/skills/handoff/scripts/find_handoffs.sh`
     (remote branches carrying the file, newest first). One candidate → use
     it. Several → show them and ask which one.
2. **Read the whole file** before touching anything.
3. **Bring the work onto this session's branch.** If the current branch does
   not already contain it: `git fetch origin <old-branch>` then
   `git merge origin/<old-branch>` (fast-forwards when this branch is fresh).
   Push only to this session's designated branch. If the old branch has an
   open PR, ask the user first: keep pushing to the old branch (the PR
   updates) or continue here (a new PR later, the old one closed).
4. **Verify before continuing** — compare the file against reality:
   - The commits and HEAD it names exist (`git log --oneline -15`).
   - `git status` is clean after the merge.
   - Re-run its verification commands (`npm ci --ignore-scripts` first if
     needed) and compare with the recorded results.
   - Check every "진행 중 · 외부 상태" item: PR state and CI via GitHub MCP;
     whether a publish or deploy already happened before redoing it.
   - Re-subscribe to the PR here if it still needs watching.
5. **Report in Korean**, briefly: what matches, what does not, and the next
   step you are about to take. If a mismatch changes the plan, ask before
   proceeding; otherwise carry on with "다음 한 걸음".
6. Do not redo items marked done, and do not restart in-flight work (deploy,
   npm publish, release) until you have confirmed it did not already happen.

## Close

When everything under "남은 작업" is finished — before the PR is marked ready
or merged — run `git rm .claude/handoff.md`, commit
`chore(handoff): 인계 파일 정리`, and push. A handoff that lands on `main` goes
stale and misleads later sessions, exactly like `.claude/next-sessions.md`.

## When to suggest a handoff yourself

- A PR-sized milestone is done but the overall task continues.
- A long, separable phase is about to start.
- Earlier parts of this conversation were auto-summarized, or you notice you
  are re-reading files you already covered.

Do not suggest one for ordinary small tasks: here one session usually equals
one PR, and the PR itself is the record.

## Template

```markdown
# 세션 인계

- 작성: YYYY-MM-DD HH:MM KST
- 브랜치: `ccr-xxxx` (base: `main` @ abc1234)
- HEAD: `def5678` — <커밋 제목>
- PR: #NN (open · CI green) / 없음

## 목표
<사용자가 요청한 것 — 사용자 표현 그대로 1~3줄>

## 완료
- [x] <항목> (`abc1234`)

## 남은 작업 (순서대로)
1. <항목>

## 다음 한 걸음
<새 세션이 가장 먼저 할 구체적 행동 1개 — 파일·함수 이름까지>

## 결정 사항 · 제약
- 사용자 결정: <무엇을, 왜>
- 버린 방법과 이유: <다시 시도하지 않도록>

## 검증 방법
| 명령 | 인계 시점 결과 |
|---|---|
| `npm run typecheck` | 통과 / 실패 / 미실행 |
| `npm test` | N passed / M failed / 미실행 |

## 진행 중 · 외부 상태
- PR 구독, 예약 점검, 배포·npm 게시 진행 여부 — 없으면 "없음"

## 미확인 · 질문
- <확인 못 한 것, 사용자에게 물어야 할 것>
```
