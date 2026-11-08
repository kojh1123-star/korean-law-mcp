---
name: warn-npm-publish-checklist
enabled: true
event: bash
action: warn
pattern: \bnpm\s+publish\b
---

📦 **npm publish 감지 — 배포 절차 확인** (CLAUDE.md 상단 "배포 — 통합 호스트")

게시 다음 순서:
1. `npm view korean-law-mcp version` 이 새 버전을 반환할 때까지 대기 — 전파 전에 배포하면 이미지가 옛 버전을 설치한다
2. `~/workspace/gomdori-mcp/Dockerfile` 의 `korean-law-mcp@X.Y.Z` 핀 갱신
3. `cd ~/workspace/gomdori-mcp && fly deploy -c fly.production.toml` — 이 레포에서 `fly deploy` 금지
4. `gh release create vX.Y.Z` — 노트는 CHANGELOG 해당 절. Release 누락 전례: v4.10.0·v4.11.0
5. `gomdori-mcp/scripts/verify-deploy.sh` 로 사용자 경로 반영 확인
