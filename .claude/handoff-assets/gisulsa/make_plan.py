#!/usr/bin/env python3
"""전 문항 모범답안 작성 계획표 생성기 (원문 사실은 넣지 않음 — 문항 구조만 분해).

사용:
  python3 make_plan.py --questions questions.json --keywords keywords.json \
      --minors minors.json --index answer_index.json -o answer_plan.json

문항마다: 소문항 분해, 요구 요소(정의·원리·비교·대책·기준·계산·도식 등), 필수 빈출 키워드,
재출제 그룹 형제 문항, 권장 목차, 근거 유형 힌트, 작성 우선순위, 상태(todo/done)를 만든다.
"""
import argparse, json, re
from collections import defaultdict

DEMANDS = [
    ("정의", r"정의|개념|의미|이란|란\?"), ("원리", r"원리|메커니즘|반응|기작|이론"),
    ("특징", r"특징|특성|성상"), ("종류", r"종류|분류|유형|형식|방식"),
    ("비교", r"비교|차이|구분|대비"), ("장단점", r"장\s*[·.,․]?\s*단점|장점|단점"),
    ("문제점·원인", r"문제점|장애|원인|영향"), ("대책", r"대책|방안|개선|저감|방지|해결|관리방법|관리 방법"),
    ("공정·설비", r"공정|흐름|처리방법|처리 방법|시설|설비|장치|기술"),
    ("법령·기준", r"기준|규정|법률|법」|법\"|법”|고시|시행령|시행규칙|허가|신고|검사|지침|제도"),
    ("절차·단계", r"절차|단계|순서|과정"), ("계산·산정", r"계산|산정|식을|관계식|구하시오|효율|산출"),
    ("도식", r"도식|그래프|그림|흐름도|도시하"), ("정책·동향", r"정책|계획|전략|동향|추세|이슈|최근"),
]
ORDER = {"S": 0, "A": 1, "B": 2}


def split_items(text):
    parts = [p.strip() for p in text.split(" / ") if p.strip()]
    items = [p for p in parts[1:] if re.match(r"^(\d+\)|[가-하]\.|\(\d+\))", p)]
    if not items:
        items = [m.strip() for m in re.findall(r"\d+\)\s*([^/]+?)(?=\s*\d+\)|$)", text)]
    return items


def toc(q, items, demands):
    if q["type"] == "단답":
        secs = ["1. 정의"]
        body = [d for d in demands if d not in ("정의",)][:2] or ["핵심 내용"]
        secs += [f"{i + 2}. {d}" for i, d in enumerate(body)]
        return secs
    secs = ["1. 개요"]
    body = [re.sub(r"^(\d+\)|[가-하]\.|\(\d+\))\s*", "", s)[:30] for s in items] or \
           [d for d in demands if d not in ("정의", "도식", "정책·동향")][:4] or ["본문"]
    secs += [f"{i + 2}. {s}" for i, s in enumerate(body)]
    secs.append(f"{len(secs) + 1}. 결론 및 제언")
    return secs


def main():
    ap = argparse.ArgumentParser()
    for a in ("questions", "keywords", "minors", "index"):
        ap.add_argument("--" + a, required=True)
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args()
    Q = json.load(open(a.questions, encoding="utf-8"))
    K = json.load(open(a.keywords, encoding="utf-8"))
    tier = {m["code"]: m["tier"] for m in json.load(open(a.minors, encoding="utf-8")) if m["window"] == "10y"}
    done = {r["id"] for r in json.load(open(a.index, encoding="utf-8"))}
    grp = defaultdict(list)
    for q in Q:
        if q["repeat_group"]:
            grp[q["repeat_group"]].append(q["id"])
    plan = []
    for q in Q:
        items = split_items(q["text"])
        dem = [n for n, rx in DEMANDS if re.search(rx, q["text"])]
        if q.get("diagram") and "도식" not in dem:
            dem.append("도식")
        if q.get("law") and "법령·기준" not in dem:
            dem.append("법령·기준")
        kw = [k["keyword"] for k in K if q["id"] in k["ids"].split()]
        plan.append({
            "id": q["id"], "status": "done" if q["id"] in done else "todo",
            "type": q["type"], "pts": q["pts"], "major_code": q["major_code"], "minor": q["minor"],
            "minor_name": q["minor_name"], "tier": tier.get(q["minor"], "B"), "recent5": q["recent5"],
            "repeat_group": q["repeat_group"], "siblings": [s for s in grp.get(q["repeat_group"], []) if s != q["id"]],
            "items": items, "demands": dem, "keywords": kw, "toc": toc(q, items, dem),
            "source_hint": "법령·고시 원문 우선" if "법령·기준" in dem else "공식 지침·통계 또는 DOI 논문",
            "needs": {"table": True, "figure": q["type"] == "서술" or "도식" in dem},
        })
    plan.sort(key=lambda p: (p["status"] == "done", ORDER[p["tier"]], not p["recent5"],
                             -len(grp.get(p["repeat_group"], [])), p["repeat_group"] or p["id"], p["id"]))
    for i, p in enumerate(plan, 1):
        p["order"] = i
    json.dump(plan, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    todo = [p for p in plan if p["status"] == "todo"]
    by = defaultdict(int)
    for p in todo:
        by[(p["tier"], p["type"])] += 1
    print(f"전체 {len(plan)} · 작성 대상 {len(todo)} · 완료 {len(plan) - len(todo)}")
    print("등급×유형:", dict(sorted(by.items())))
    print("소문항 분해된 문항:", sum(1 for p in todo if p["items"]))
    print("필수 키워드 있는 문항:", sum(1 for p in todo if p["keywords"]))


if __name__ == "__main__":
    main()
