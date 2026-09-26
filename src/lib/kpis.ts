// Headline figures for a run: shared by the page and the analyst so both report the same numbers.
import { scoreToGrade } from './grade'
import type { Inputs, RunResult, WeekResult } from './types'

export interface Kpis {
  worstWeek: number | null
  worstGrade: string
  worstChannel: string
  weeksBelowTarget: { voice: number; chat: number; email: number }
  peakUtilisation: number
  largestFteGap: { week: number; fte: number }
  worstEmailBacklogDays: number
  peakAbandonment: { voice: { rate: number; week: number }; chat: { rate: number; week: number } } // 0 under Erlang C
  totalAbandoned: { voice: number; chat: number }
  gradeCappedByAbandonment: boolean // the worst week's grade was capped by abandonment
  idleBorrowedHours: number
  freezeStart: number
  freezeEnd: number
  waveWeeks: number[]
  headcountFlows: RunResult['flows']
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`

/** Worst attainment of a week's scored channels (service ÷ target; email its on-time index). */
export function worstAttainment(inp: Inputs, w: WeekResult): number {
  const t = inp.channels
  return Math.min(
    w.voice.scored ? w.voice.sl / t.voice.slTarget : Infinity,
    w.chat.scored ? w.chat.sl / t.chat.slTarget : Infinity,
    w.email.scored ? w.email.timeliness : Infinity,
  )
}

/**
 * The worst graded week: lowest score; ties (several D- weeks) broken by the lowest attainment,
 * then the earliest week. The page, the KPIs and the dossier all use this rule.
 */
export function worstWeek(inp: Inputs, r: RunResult): WeekResult | null {
  let best: WeekResult | null = null
  for (const w of r.weeks) {
    if (!Number.isFinite(w.score)) continue
    if (!best || w.score < best.score - 1e-12 || (Math.abs(w.score - best.score) <= 1e-12 && worstAttainment(inp, w) < worstAttainment(inp, best) - 1e-12)) best = w
  }
  return best
}

export function kpis(inp: Inputs, r: RunResult): Kpis {
  const worst = worstWeek(inp, r)
  const t = inp.channels
  let worstChannel = ''
  if (worst) {
    const c = [
      worst.voice.scored ? { k: `Voice ${pct(worst.voice.sl)}`, a: worst.voice.sl / t.voice.slTarget } : null,
      worst.chat.scored ? { k: `Chat ${pct(worst.chat.sl)}`, a: worst.chat.sl / t.chat.slTarget } : null,
      worst.email.scored ? { k: `Email ${pct(worst.email.timeliness)} on time`, a: worst.email.timeliness } : null,
    ].filter((x): x is { k: string; a: number } => !!x)
    worstChannel = c.sort((x, y) => x.a - y.a)[0]?.k ?? ''
  }
  const peak = (ch: 'voice' | 'chat') =>
    r.weeks.reduce((a, w) => (w[ch].scored && w[ch].abandonRate > a.rate ? { rate: w[ch].abandonRate, week: w.week } : a), { rate: 0, week: 0 })
  const capped = !!worst && worst.cappedByAbandonment
  const gap = r.weeks.length ? r.weeks.reduce((a, w) => (w.fteReq - w.fteAvail > a.fteReq - a.fteAvail ? w : a), r.weeks[0]) : null
  return {
    worstWeek: worst?.week ?? null,
    worstGrade: worst ? scoreToGrade(worst.score).grade : '—',
    worstChannel,
    weeksBelowTarget: {
      voice: r.weeks.filter((w) => w.voice.scored && w.voice.sl < t.voice.slTarget - 1e-6).length,
      chat: r.weeks.filter((w) => w.chat.scored && w.chat.sl < t.chat.slTarget - 1e-6).length,
      email: r.weeks.filter((w) => w.email.scored && w.email.timeliness < 1 - 1e-6).length,
    },
    peakUtilisation: Math.max(0, ...r.weeks.map((w) => (Number.isFinite(w.utilisation) ? w.utilisation : 0))),
    largestFteGap: gap ? { week: gap.week, fte: Math.max(0, gap.fteReq - gap.fteAvail) } : { week: 0, fte: 0 },
    worstEmailBacklogDays: Math.max(0, ...r.weeks.map((w) => w.email.backlogDays)),
    peakAbandonment: { voice: peak('voice'), chat: peak('chat') },
    totalAbandoned: { voice: r.weeks.reduce((s, w) => s + w.voice.abandoned, 0), chat: r.weeks.reduce((s, w) => s + w.chat.abandoned, 0) },
    gradeCappedByAbandonment: capped,
    idleBorrowedHours: r.weeks.reduce((s, w) => s + w.borrowedIdleHours, 0),
    freezeStart: r.freezeStart,
    freezeEnd: r.freezeEnd,
    waveWeeks: r.waveWeeks,
    headcountFlows: r.flows,
  }
}
