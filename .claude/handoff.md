# 세션 인계

- 작성: 2026-10-15 22:58 KST (3차 갱신)
- 브랜치: `ccr-1c8cdaf4-l95i9v` (base: `main` @ 3ebaf5e)
- HEAD: 이 인계 커밋 (레포 코드 변경 없음 — `.claude/` 아래 인계 자료만)
- PR: 없음

> ⚠️ **클라우드 세션에서는 진행 불가 확인됨**: 컨테이너 네트워크 정책이 law.go.kr·me.go.kr·nier.go.kr·keco.or.kr·epa.gov·doi.org 를
> 모두 차단(프록시 403), WebFetch 도 실패. WebSearch 는 되지만 요약문만 줘서 원문 대조 불가.
> → **노트북 로컬 세션(법령 MCP + 일반 인터넷)에서 진행**하거나, 클라우드 환경의 Network access 를 넓히고 `LAW_OC` 를 넣은 새 세션에서 진행.

## 목표
「폐기물처리기술사 기출 숲 지도」 대시보드(https://claude.ai/artifact/BrhT7gn1iCvRDufV2LfezA)의 **기출 전 항목**에 대해
매립가스 답안(134-4-06)처럼 필수 키워드·표·그림이 들어간 모범답안을 작성한다. "비용도 비용이지만 퀄리티도 높아야 해(팩트만)".

## 완료
- [x] 대시보드 데이터·답안 화면 코드 분석 (대시보드에 쓴 것은 아직 없음)
- [x] 작성 규칙 확정 (아래 결정 사항)
- [x] 자동 점검기 `.claude/handoff-assets/gisulsa/check_answers.py` (표준 라이브러리만, 모델 호출 없음)
  - 점검: 필수 구성(meta·h·표·그림·채점 포인트·출처), 출처 rel=높음·https·허용 도메인·quote, 수치·법령·정의 행의 ref 연결,
    표·그래프·SVG 구조, 빈출 키워드 포함, 대분류·색인 일치. `--sources DIR`(원문 텍스트, 파일명=url sha1.txt)로 인용 대조
  - 사용: `python3 check_answers.py answers_EN.json --questions questions.json --keywords keywords.json --index answer_index.json`
  - 기존 LFG 답안(134-4-06) 결과: ERROR 31 (ref·quote 없음, 출처 6건 모두 quote 없음), WARN 1 (cues.rutgers.edu = EPA 문서 미러)
- [x] 작성 계획표 생성기 `.claude/handoff-assets/gisulsa/make_plan.py` — 문항별 소문항 분해·요구 요소·필수 키워드·형제 문항·권장 목차·근거 유형·우선순위
  - 사용: `python3 make_plan.py --questions questions.json --keywords keywords.json --minors minors.json --index answer_index.json -o answer_plan.json`
  - 결과(2026-10-15): 작성 대상 371 (S 서술 101·단답 77 / A 66·52 / B 48·27), 필수 키워드 있는 문항 327, 소문항 분해 40. 1순위 128-4-01·140-2-04(SRF)
  - 목차·요구 요소는 문항 문구 정규식 추정 — 작성할 때 문항 원문을 보고 조정할 것 (단답 78개는 용어형이라 요구 요소 비어 있음)

## 남은 작업 (순서대로)
1. 시범 5개 그룹(17문항) 작성 → 문항당 사용량·근거 미확보 비율 측정
   - EN02 SRF 품질기준: 111-1-09, 119-3-03, 128-4-01, 140-2-04
   - RC01 폐플라스틱 재활용 방법: 116-1-04, 122-4-01, 134-4-02, 137-2-06
   - EN05 음식물 바이오가스화 공정: 116-2-02, 119-2-04, 128-2-04 (교과서 없이 공학 원리를 채울 수 있는지 시험)
   - IN10 디노버 합성(단답): 110-1-05, 128-1-08, 140-1-12
   - RC04 폐기물부담금(단답): 113-1-13, 134-1-09, 140-1-03
2. 결과 보고 후 나머지 문항을 중분류(71개) 단위로 진행
3. 모범답안 색인(answer_index) 134-4-06 검토 상태 불일치 정리 (색인 "검토 전" ↔ 답안 설명 "Fable 검토 거침")
4. LFG 답안(134-4-06)에 ref·quote 보강해 점검기 통과시키기 (EPA 문서는 epa.gov 원본 URL로 교체 검토)
5. 모든 작업 끝나면 인계 Close: `.claude/handoff.md`·`.claude/handoff-assets/` 삭제 (main 에 들어가지 않게)

## 다음 한 걸음
(노트북 로컬 세션) 법령 MCP·원문 사이트 접속 확인 → Artifact read로 `answers_LF`(`/_blob/1e3f738114423ea2364b05d26bc4a6d0`)·questions·keywords·minors·answer_index 받기
→ `make_plan.py` 로 계획표 생성 → order 순으로 SRF 그룹(128-4-01·140-2-04·119-3-03·111-1-09)부터 근거 수집 → 답안 작성 → `check_answers.py` ERROR 0 확인 → 대시보드 반영.

## 결정 사항 · 제약
- 근거: **법령·고시 원문, 정부·공공기관 공식 문서(환경부·국립환경과학원·한국환경공단, US EPA, IPCC, 협약문 등), DOI 있는 동료심사 논문만**. 교과서·수험서·학원 교재·블로그 제외.
- 근거 못 찾은 내용: **본문에서 빼고 "근거 미확보" 목록에 남김** (저장 위치는 미정).
- 수치·법 조문·정의·기준값마다 출처 URL + 원문 인용문 1줄. 개념도는 "개념도", 계산 예는 "가정값" 표시.
  - 새 필드(화면은 무시하므로 안전): src 행 `quote`(원문 인용문), 사실 행 `ref`(같은 문항 src 의 seq 공백 구분, 또는 `가정`/`계산`).
- 법령은 **현행 기준**으로 쓰고 기출 당시 법명은 개정 내용 한 줄 (예: 자원순환기본법 → 순환경제사회 전환 촉진법, 시점은 법령 조회로 확인).
- 환경: 회사는 구독형(배치·캐싱 불가). 용도: 본인 학습용. Fable 어드바이저는 쓰지 않고 자동 점검(키워드·표·그림·출처 도메인·인용 대조·계산 검산)으로 대체.
- 범위: "전 항목" = 문항 372개 중 남은 371개 **각 문항 id마다** 답안 행 필요 (화면은 그룹 형제 문항에 안내만 띄움). 같은 그룹은 근거·부품을 공유하되 문항별로 묻는 항목에 맞춤.
- 규모 참고: 서술 216·단답 156 / 재출제 그룹 64개(154문항) / 등급별 답안 단위 S 132·A 87·B 63.

## 대시보드 답안 구조 (화면 코드 확인함)
- 화면은 `answer_index`에 문항 id가 있으면 데이터셋 `answers_<대분류코드>`(MG·IN·PY·LF·EN·RC·SL·SO·AN·EA·IC·CP·CL·ET)를 읽음. 지금은 `answers_LF`만 있음.
- 데이터셋 문서: `datasets/<id>` = {title, description, source:{kind:"file", name, url:"/_blob/<id>"}, updated:{at, by}}. 파일은 Artifact publish `asset:true`로 올린 뒤 url 교체.
- `answer_index` 행: {id, major_code, answer:"모범답안", rel, review, related(공백 구분 id)}. review에 "반영"이 들어가면 초록 배지.
- 답안 행 공통: key, qid, seq, kind, text. `lv:"ref"`면 "실전 분량만"에서 숨김.
- kind: meta(c1 배점·시간, c2 신뢰도, c3 근거 요약, c4 작성일, c5 관련 기출, c6 출제 이력) · term(c1 용어) · h · li · p · note · tip · formula(c1) · flow(text를 " → "로 구분, c1 제목) · table(grp, c1~c6 머리글)+tr(grp) · chart(grp, c1 x축, c2 y축)+band(grp,x0,x1,text)+pt(grp,series,x,y, c1 "dash"=점선, c2 단위) · svg(text=SVG 원문, c1 캡션; class t·tb·tm·tx·k1·k2·a1·big·a2·fw·cv·l1~l4·fd·box·rain) · point(채점 포인트) · src(text, c1 근거 항목, url https, rel).
- 주요 파일: questions `/_blob/c8c725754db61bf1f65fb92cdbb62ff9`, minors `/_blob/63256a20a3c4711b0358371ab59d6830`, keywords `/_blob/1fcc3e70e4b3f92789fb1e77a63f5a10`, outline `/_blob/23f35b14fa07d67fa321d4e0c3022936`, answer_index `/_blob/adde51dc8c4bf7a226eafd7f7f631675`.

## 검증 방법
| 명령 | 인계 시점 결과 |
|---|---|
| `npm run typecheck` | 미실행 (코드 변경 없음) |
| `npm test` | 미실행 (코드 변경 없음) |

## 진행 중 · 외부 상태
- 없음 (대시보드 쓰기 0건, PR·예약 점검 없음)

## 미확인 · 질문
- 노트북 세션에서 법령 MCP 도구 이름·호출 가능 여부, Artifact 도구(claude.ai 로그인) 사용 가능 여부
  (이 대화는 노트북 데스크톱 앱에서 열어도 클라우드 컨테이너에서 돈다 — 로컬 법령 MCP 는 붙지 않음. 노트북에서 **로컬 세션**을 새로 열어야 함)
- 근거 미확보 목록 저장 위치 (예: 새 데이터셋 `answer_gaps`) — 사용자 확인 필요
- 문항당 사용량은 시범 후 산정
