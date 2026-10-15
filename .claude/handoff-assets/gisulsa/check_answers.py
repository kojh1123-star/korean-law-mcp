#!/usr/bin/env python3
"""기술사 모범답안 자동 점검기 (표준 라이브러리만 사용, 모델 호출 없음).

사용:
  python3 check_answers.py answers_EN.json --questions questions.json \
      --keywords keywords.json [--index answer_index.json] [--sources DIR] [--allow host ...]

점검 규칙(2026-10-15 사용자 확정):
  - 근거는 법령·고시 원문, 정부·공공기관 공식 문서, DOI 있는 동료심사 논문만 (src.rel = "높음").
  - 수치·법 조문·정의·기준값이 든 행은 ref 필드로 근거를 가리킨다.
    ref 토큰 = 같은 문항 src 행의 seq 또는 key, 또는 "가정"(가정값) / "계산"(다른 행에서 계산).
  - src 행은 quote(원문 인용문)를 가진다. --sources DIR 에 원문 텍스트(파일명 = url 의 sha1 + .txt)가
    있으면 인용문이 원문에 그대로 있는지 대조한다.
종료 코드: ERROR 가 하나라도 있으면 1.
"""
import argparse, hashlib, json, os, re, sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from urllib.parse import urlparse

KINDS = {"meta", "term", "h", "li", "p", "note", "tip", "formula", "flow", "table", "tr",
         "chart", "band", "pt", "svg", "point", "src"}
FACT_KINDS = {"li", "p", "note", "tip", "term", "formula", "flow", "tr"}
ALLOWED_HOSTS = [".go.kr", "keco.or.kr", "kosis.kr", ".gov", ".europa.eu", "ipcc.ch",
                 "ipcc-nggip.iges.or.jp", "basel.int", "mercuryconvention.org", "pops.int",
                 "unep.org", "oecd.org", "who.int", "doi.org", ".go.jp", ".lg.jp", "gov.uk"]
SVG_TAGS = {"svg", "g", "defs", "marker", "path", "rect", "circle", "ellipse", "line",
            "polyline", "polygon", "text", "tspan", "title"}
SVG_CLASSES = {"t", "tb", "tm", "tx", "k1", "k2", "a1", "big", "a2", "fw", "cv", "l1", "l2",
               "l3", "l4", "fd", "box", "rain"}
UNIT = r"(%|℃|°C|mg|kg|g/|ppm|ppb|mm|cm|m²|m³|Nm³|m/|km|kcal|MJ|kJ|kW|MW|톤|t/|L/|일|년|개월|배|회|시간|분|초|이상|이하|미만|초과)"
NUM_FACT = re.compile(r"\d+(?:[.,]\d+)?\s*(?:~\s*\d+(?:[.,]\d+)?\s*)?" + UNIT
                      + r"|\d+\.\d+|pH\s*(?:약\s*)?\d")
LAW_FACT = re.compile(r"제\s*\d+\s*조|별표\s*\d|시행령|시행규칙|고시\s*제|법률\s*제")


def norm(s):
    return re.sub(r"\s+", "", s or "")


def host_ok(url, extra):
    host = (urlparse(url).hostname or "").lower()
    return any(host == a.lstrip(".") or host.endswith(a if a.startswith(".") else "." + a) or host == a
               for a in ALLOWED_HOSTS + extra)


def row_text(r):
    return " ".join(str(r.get(k, "")) for k in ("text", "c1", "c2", "c3", "c4", "c5", "c6"))


def check(args):
    rows = json.load(open(args.answers, encoding="utf-8"))
    qs = {q["id"]: q for q in json.load(open(args.questions, encoding="utf-8"))}
    kws = json.load(open(args.keywords, encoding="utf-8")) if args.keywords else []
    idx = {r["id"]: r for r in json.load(open(args.index, encoding="utf-8"))} if args.index else None
    m = re.search(r"answers_([A-Z]{2})", os.path.basename(args.answers))
    major = args.major or (m.group(1) if m else None)
    out = []
    say = lambda lv, qid, msg: out.append((lv, qid, msg))

    seen_keys = set()
    by_q = defaultdict(list)
    for r in rows:
        for f in ("key", "qid", "seq", "kind"):
            if f not in r:
                say("ERROR", r.get("qid", "?"), f"필수 필드 {f} 없음: {json.dumps(r, ensure_ascii=False)[:80]}")
        if r.get("key") in seen_keys:
            say("ERROR", r.get("qid", "?"), f"key 중복 {r.get('key')}")
        seen_keys.add(r.get("key"))
        if r.get("kind") not in KINDS:
            say("ERROR", r.get("qid", "?"), f"알 수 없는 kind {r.get('kind')} (seq {r.get('seq')})")
        by_q[r.get("qid")].append(r)

    for qid, A in by_q.items():
        q = qs.get(qid)
        if not q:
            say("ERROR", qid, "questions 에 없는 문항 id"); continue
        if major and q["major_code"] != major:
            say("ERROR", qid, f"대분류 {q['major_code']} 문항이 answers_{major} 에 들어 있음")
        seqs = [r.get("seq") for r in A]
        if len(seqs) != len(set(seqs)):
            say("ERROR", qid, "seq 중복")
        K = defaultdict(list)
        for r in A:
            K[r["kind"]].append(r)
        essay = q["type"] == "서술"
        # 1. 필수 구성
        if len(K["meta"]) != 1:
            say("ERROR", qid, f"meta 행이 {len(K['meta'])}개 (1개여야 함)")
        else:
            mt = K["meta"][0]
            if mt.get("c2") != "높음":
                say("ERROR", qid, f"meta.c2 신뢰도가 '{mt.get('c2')}' (높음이어야 함)")
            for c in ("c1", "c3", "c4"):
                if not mt.get(c):
                    say("ERROR", qid, f"meta.{c} 비어 있음")
            for rid in (mt.get("c5") or "").split():
                if rid not in qs:
                    say("ERROR", qid, f"meta.c5 관련 기출 {rid} 가 questions 에 없음")
        figs = len(K["chart"]) + len(K["svg"])
        need = (3, 1, 1, 3, 2) if essay else (1, 0, 0, 2, 1)
        if len(K["h"]) < need[0]:
            say("ERROR", qid, f"소제목(h) {len(K['h'])}개 < {need[0]}")
        if essay and (len(K["table"]) < need[1] or figs < need[2]):
            say("ERROR", qid, f"서술형은 표·그림 각 1개 이상 필요 (표 {len(K['table'])}, 그림 {figs})")
        if not essay and len(K["table"]) + figs < 1:
            say("ERROR", qid, "단답형도 표나 그림 1개 이상 필요")
        if len(K["point"]) < need[3]:
            say("ERROR", qid, f"채점 포인트 {len(K['point'])}개 < {need[3]}")
        if len(K["src"]) < need[4]:
            say("ERROR", qid, f"출처 {len(K['src'])}건 < {need[4]}")
        # 2. 출처
        src_ids = set()
        for s in K["src"]:
            src_ids.update({str(s.get("seq")), s.get("key")})
            if s.get("rel") != "높음":
                say("ERROR", qid, f"출처 seq {s.get('seq')} 신뢰도 '{s.get('rel')}' (높음만 허용)")
            url = s.get("url", "")
            if not url.startswith("https://"):
                say("ERROR", qid, f"출처 seq {s.get('seq')} url 이 https 가 아님")
            elif not host_ok(url, args.allow):
                say("WARN", qid, f"출처 seq {s.get('seq')} 허용 목록 밖 도메인 {urlparse(url).hostname}")
            if not s.get("c1"):
                say("ERROR", qid, f"출처 seq {s.get('seq')} c1(근거 항목) 비어 있음")
            quote = s.get("quote", "")
            if len(norm(quote)) < 10:
                say("ERROR", qid, f"출처 seq {s.get('seq')} quote(원문 인용문) 없음")
            elif args.sources:
                p = os.path.join(args.sources, hashlib.sha1(url.encode()).hexdigest() + ".txt")
                if not os.path.exists(p):
                    say("WARN", qid, f"출처 seq {s.get('seq')} 원문 텍스트 미보관 → 인용 대조 미실행")
                elif norm(quote) not in norm(open(p, encoding="utf-8").read()):
                    say("ERROR", qid, f"출처 seq {s.get('seq')} 인용문이 원문에 없음")
        # 3. 사실 행의 근거 연결
        for r in A:
            if r["kind"] not in FACT_KINDS:
                continue
            t = row_text(r)
            is_fact = r["kind"] in ("term", "formula") or NUM_FACT.search(t) or LAW_FACT.search(t)
            if not is_fact:
                continue
            refs = str(r.get("ref", "")).split()
            if not refs:
                say("ERROR", qid, f"{r['kind']} seq {r['seq']} 수치·법령·정의에 ref 없음: {t.strip()[:50]}")
            for tok in refs:
                if tok not in src_ids and tok not in ("가정", "계산"):
                    say("ERROR", qid, f"{r['kind']} seq {r['seq']} ref '{tok}' 가 이 문항 출처에 없음")
        # 4. 표·그림 구조
        for tb in K["table"]:
            cols = {c for c in ("c1", "c2", "c3", "c4", "c5", "c6") if tb.get(c)}
            trs = [x for x in K["tr"] if x.get("grp") == tb.get("grp")]
            if not trs:
                say("ERROR", qid, f"표 '{tb.get('text', '')[:20]}' 에 행(tr) 없음")
            for x in trs:
                extra = {c for c in ("c1", "c2", "c3", "c4", "c5", "c6") if x.get(c)} - cols
                if extra:
                    say("WARN", qid, f"표 행 seq {x['seq']} 에 머리글 없는 열 {sorted(extra)}")
        for ch in K["chart"]:
            bands = [x for x in K["band"] if x.get("grp") == ch.get("grp")]
            pts = [x for x in K["pt"] if x.get("grp") == ch.get("grp")]
            if len(bands) < 1 or len({p.get("series") for p in pts}) < 1 or len(pts) < 2:
                say("ERROR", qid, f"그래프 grp {ch.get('grp')} 구간·점 부족")
            if "개념" not in ch.get("text", "") and not ch.get("ref"):
                say("ERROR", qid, f"그래프 grp {ch.get('grp')} 는 '개념도' 표시나 ref 필요")
        for sv in K["svg"]:
            try:
                root = ET.fromstring(sv.get("text", ""))
            except ET.ParseError as e:
                say("ERROR", qid, f"SVG seq {sv['seq']} 파싱 실패: {e}"); continue
            for el in root.iter():
                tag = el.tag.split("}")[-1]
                if tag not in SVG_TAGS:
                    say("WARN", qid, f"SVG seq {sv['seq']} 화면에서 지워지는 태그 <{tag}>")
                for c in (el.get("class") or "").split():
                    if c not in SVG_CLASSES:
                        say("WARN", qid, f"SVG seq {sv['seq']} 스타일 없는 class '{c}'")
            if not sv.get("c1"):
                say("WARN", qid, f"SVG seq {sv['seq']} 캡션(c1) 없음")
        # 5. 필수 키워드
        body = " ".join(row_text(r) for r in A)
        for k in kws:
            if qid in k.get("ids", "").split():
                if not any(v and v in body for v in k["keyword"].split("·")):
                    say("ERROR", qid, f"빈출 키워드 '{k['keyword']}' 가 답안에 없음")
        # 6. 색인
        if idx is not None:
            ix = idx.get(qid)
            if not ix:
                say("ERROR", qid, "answer_index 에 없음")
            elif ix.get("major_code") != q["major_code"] or ix.get("rel") != "높음":
                say("ERROR", qid, "answer_index 의 major_code/rel 불일치")
    return out, len(by_q)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("answers"); ap.add_argument("--questions", required=True)
    ap.add_argument("--keywords"); ap.add_argument("--index"); ap.add_argument("--sources")
    ap.add_argument("--major"); ap.add_argument("--allow", nargs="*", default=[])
    args = ap.parse_args()
    out, n = check(args)
    for lv, qid, msg in sorted(out, key=lambda x: (x[1], x[0])):
        print(f"{lv:5} {qid}  {msg}")
    e = sum(1 for o in out if o[0] == "ERROR"); w = len(out) - e
    print(f"\n문항 {n}개 · ERROR {e} · WARN {w}")
    sys.exit(1 if e else 0)


if __name__ == "__main__":
    main()
