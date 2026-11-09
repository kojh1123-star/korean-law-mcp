/**
 * 자연어 시간 표현 패턴 테이블 (date-parser 의 데이터부)
 *
 * 순서가 규칙이다 — 구체적인 표현이 먼저 와야 한다. 맨 뒤의 "YYYY년" 단독이
 * 앞에 오면 "2020년부터 2023년까지"의 시작 연도만 집어삼킨다.
 */
import type { DateRange } from "./date-types.js"

/** YYYYMMDD 포맷 */
function fmt(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}${m}${day}`
}

/** 오늘 기준 N개월 전 */
function monthsAgo(n: number, base: Date = new Date()): Date {
  const d = new Date(base)
  const day = d.getDate()
  // 월말에서 짧은 달로 이동하면 setMonth가 다음 달로 넘기므로 1일에서 이동 후 보정한다.
  d.setDate(1)
  d.setMonth(d.getMonth() - n)
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, lastDay))
  return d
}

/** 오늘 기준 N년 전 */
function yearsAgo(n: number, base: Date = new Date()): Date {
  const d = new Date(base)
  d.setFullYear(d.getFullYear() - n)
  return d
}

/** 오늘 기준 N일 전 */
function daysAgo(n: number, base: Date = new Date()): Date {
  const d = new Date(base)
  d.setDate(d.getDate() - n)
  return d
}

/** 특정 연/월의 첫날 */
function monthStart(year: number, month: number): Date {
  return new Date(year, month - 1, 1)
}

/** 특정 연/월의 마지막날 */
function monthEnd(year: number, month: number): Date {
  return new Date(year, month, 0)
}


/**
 * 상대 시점 어휘 — 이 어휘의 집(#144). `date-parser` 분할이 날짜 어휘의 집을 여기 만들었는데
 * 걷어내기·시나리오 판정이 각자 다시 적고 있었다. 두 벌이 되면 한쪽에만 낱말이 늘어난다.
 *
 * 판정용으로 좁혀 쓰는 자리는 자기 정규식을 그대로 둔다 — 넓히면 라우팅이 바뀐다(동작 변경).
 */
export const RELATIVE_PAST_WORDS = "작년|재작년|예전|과거|종전"
export const RELATIVE_NOW_WORDS = "지금|현재|현행|오늘|올해"

export interface TimePattern {
  regex: RegExp
  resolve: (m: RegExpMatchArray) => DateRange
}

export const TIME_PATTERNS: TimePattern[] = [
  // "2020년부터 2023년까지" / "2020~2023"
  {
    regex: /(\d{4})\s*(?:년\s*)?(?:부터|~|–|-)\s*(\d{4})\s*(?:년\s*)?(?:까지)?/,
    resolve: (m) => ({
      from: `${m[1]}0101`,
      to: `${m[2]}1231`,
    }),
  },
  // "최근 N년"
  {
    regex: /최근\s*(\d+)\s*년/,
    resolve: (m) => ({
      from: fmt(yearsAgo(parseInt(m[1], 10))),
      to: fmt(new Date()),
    }),
  },
  // "최근 N개월"
  {
    regex: /최근\s*(\d+)\s*개월/,
    resolve: (m) => ({
      from: fmt(monthsAgo(parseInt(m[1], 10))),
      to: fmt(new Date()),
    }),
  },
  // "YYYY년 이후" / "YYYY년부터"
  {
    regex: /(\d{4})\s*년\s*(?:이후|이래|부터)/,
    resolve: (m) => ({
      from: `${m[1]}0101`,
      to: fmt(new Date()),
    }),
  },
  // "YYYY년 이전" / "YYYY년까지"
  {
    regex: /(\d{4})\s*년\s*(?:이전|까지|전)/,
    resolve: (m) => ({
      from: "19480101",
      to: `${m[1]}1231`,
    }),
  },
  // "N개월 전"
  {
    regex: /(\d+)\s*개월\s*전/,
    resolve: (m) => {
      const t = monthsAgo(parseInt(m[1], 10))
      return { from: fmt(monthStart(t.getFullYear(), t.getMonth() + 1)), to: fmt(monthEnd(t.getFullYear(), t.getMonth() + 1)) }
    },
  },
  // "YYYY년 N월" (특정 월)
  {
    regex: /(\d{4})\s*년\s*(\d{1,2})\s*월/,
    resolve: (m) => {
      const y = parseInt(m[1], 10)
      const mo = parseInt(m[2], 10)
      return { from: fmt(monthStart(y, mo)), to: fmt(monthEnd(y, mo)) }
    },
  },
  // "올해 상반기" / "올해 하반기"
  {
    regex: /올해\s*(상반기|하반기)/,
    resolve: (m) => {
      const y = new Date().getFullYear()
      if (m[1] === "상반기") return { from: `${y}0101`, to: `${y}0630` }
      return { from: `${y}0701`, to: `${y}1231` }
    },
  },
  // "지난달" / "이번달" / "저번달"
  {
    regex: /(지난달|저번달|이번\s*달)/,
    resolve: (m) => {
      const now = new Date()
      if (/이번/.test(m[1])) {
        return { from: fmt(monthStart(now.getFullYear(), now.getMonth() + 1)), to: fmt(monthEnd(now.getFullYear(), now.getMonth() + 1)) }
      }
      const p = monthsAgo(1, now)
      return { from: fmt(monthStart(p.getFullYear(), p.getMonth() + 1)), to: fmt(monthEnd(p.getFullYear(), p.getMonth() + 1)) }
    },
  },
  // "지난주" / "이번주"
  {
    regex: /(지난주|이번\s*주)/,
    resolve: (m) => {
      const now = new Date()
      const day = now.getDay() // 0=Sun
      if (/이번/.test(m[1])) {
        const mon = daysAgo(day === 0 ? 6 : day - 1, now)
        const sun = new Date(mon)
        sun.setDate(mon.getDate() + 6)
        return { from: fmt(mon), to: fmt(sun) }
      }
      // 지난주: 이번주 월요일 -7 ~ -1
      const thisMon = daysAgo(day === 0 ? 6 : day - 1, now)
      const lastMon = daysAgo(7, thisMon)
      const lastSun = daysAgo(1, thisMon)
      return { from: fmt(lastMon), to: fmt(lastSun) }
    },
  },
  // "작년" / "올해" / "재작년"
  // 여기만 `금년`을 아는 이유: 이 규칙은 어휘를 **연 범위로 해석**하는 유일한 자리다.
  // RELATIVE_* 는 "걷어낼 말"의 목록이라 해석 대상이 아닌 낱말을 넣을 이유가 없다.
  {
    regex: /(재작년|작년|올해|금년)/,
    resolve: (m) => {
      const now = new Date()
      const y = now.getFullYear()
      let target = y
      if (m[1] === "작년") target = y - 1
      else if (m[1] === "재작년") target = y - 2
      return { from: `${target}0101`, to: `${target}1231` }
    },
  },
  // "최신" / "요즘" / "근래" → 최근 3년
  {
    regex: /(?:^|\s)(최신|요즘|근래)(?:\s|$)/,
    resolve: () => ({
      from: fmt(yearsAgo(3)),
      to: fmt(new Date()),
    }),
  },
  // "YYYY년" 단독 — 그 해 전체. 반드시 마지막에 둔다(위 구체 패턴이 먼저 잡아야 한다).
  // 앞뒤에 또 다른 "YYYY년"이 있으면 두 시점 비교이므로 여기서 처리하지 않는다 —
  // 잡으면 time_travel 이 뽑아 둔 toDate 를 그 해 말일로 덮어쓴다(양방향 확인 필수)
  {
    regex: /(?<!\d{4}\s*년[\s\S]{0,20})(\d{4})\s*년(?![\s\S]{0,20}\d{4}\s*년)/,
    resolve: (m) => ({ from: `${m[1]}0101`, to: `${m[1]}1231` }),
  },
]

