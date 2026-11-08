# 커밋 + 푸시 + 통합 호스트 배포

⚠️ 2026-07-02부터 프로덕션은 [gomdori-mcp](https://github.com/chrisryugj/gomdori-mcp) 통합 호스트(fly 앱 `korean-law-mcp`, MCP 5종 동거)가 서빙합니다.
**이 레포에서 `fly deploy`를 직접 실행하면 통합 이미지가 law 단독 이미지로 덮여 stats·patent·archhub·school까지 전부 죽습니다. 절대 금지.**

절차 원본은 레포 루트 `CLAUDE.md` 상단 "⚠️ 배포 — 통합 호스트" 블록입니다. 두 문서가 어긋나면 `CLAUDE.md`를 따르고 이 파일을 맞춥니다.

## 실행할 작업

### 1단계: 커밋 & 푸시
1. `git status` / `git diff`로 변경 확인
2. `git log -3 --oneline`로 커밋 스타일 확인
3. `git add` (단, `.claude/memory/`는 제외) → 한글 prefix 커밋(feat/fix/refactor/docs/chore) → `git push`

### 2단계: npm 게시 (로컬 `npm publish`가 정규 경로)
4. `npm run build`로 빌드 확인 (실패 시 중단)
5. `npm version patch|minor` → `git push --follow-tags`
6. `npm publish`
   - `.github/workflows/publish.yml`(GitHub Release → OIDC trusted publishing + provenance)은 **npm 쪽 trusted publisher 등록이 아직 안 됐다**. 그래서 게시는 로컬 `npm publish`로 하고, GitHub Release는 게시 뒤(4단계)에 만든다.
7. **npm 전파 대기**: `npm view korean-law-mcp version`이 새 버전을 반환할 때까지 기다린다 (보통 30초 안쪽). 전파 전에 배포하면 이미지가 옛 버전을 설치한다.

### 3단계: 통합 호스트 반영
8. `~/workspace/gomdori-mcp/Dockerfile`의 `korean-law-mcp@X.Y.Z` 핀을 새 버전으로 갱신
9. `cd ~/workspace/gomdori-mcp && fly deploy -c fly.production.toml`

### 4단계: GitHub Release 생성
10. `gh release create vX.Y.Z` — 노트 본문은 `CHANGELOG.md`의 해당 버전 절을 옮긴다.
    - **릴리스는 배포와 항상 같이 간다.** npm 게시만 하고 Release를 빠뜨리면 이 레포의 릴리스 이력에 구멍이 남는다 (v4.10.0·v4.11.0이 그렇게 비었다가 2026-08-17에 소급 생성됐다).
    - Release가 `publish.yml`을 실행하지만, 같은 버전이 이미 레지스트리에 있으면 게시를 건너뛰고 검증(typecheck·test·build·verify:package·audit)만 릴리스 시점에 재확인한다.

### 5단계: 반영 확인
11. `gomdori-mcp/scripts/verify-deploy.sh`로 사용자 경로 반영 확인

## 배포 환경
- 통합 호스트: fly 앱 `korean-law-mcp` (512MB+swap) — [gomdori-mcp/fly.production.toml](https://github.com/chrisryugj/gomdori-mcp)
- 공식 URL: `https://mcp.gomdori.app/law` (구 `https://korean-law-mcp.fly.dev/mcp` 하위호환 유지)
- 롤백: `fly releases -a korean-law-mcp` → `fly deploy -a korean-law-mcp -i <직전 이미지>`
