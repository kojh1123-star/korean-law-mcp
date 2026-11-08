# 커밋 + 푸시

이 포크(kojh1123-star/korean-law-mcp)는 별도 배포 대상이 없습니다 — gomdori-mcp 통합 호스트·Railway·npm 게시를 쓰지 않습니다(npm 패키지 `korean-law-mcp` 게시 권한은 업스트림에만 있음). 반영 절차는 커밋·푸시까지입니다.
fly는 쓰지 않습니다 — 이 레포에서 `fly deploy`를 실행하지 않습니다.

절차 원본은 레포 루트 `CLAUDE.md` 상단 "⚠️ 배포" 블록입니다. 두 문서가 어긋나면 `CLAUDE.md`를 따르고 이 파일을 맞춥니다.

## 실행할 작업

1. `git status` / `git diff`로 변경 확인
2. `git log -3 --oneline`로 커밋 스타일 확인
3. `git add` (단, `.claude/memory/`는 제외) → 한글 prefix 커밋(feat/fix/refactor/docs/chore) → `git push`
