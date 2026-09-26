// Headline figures for a run: shared by the page and the analyst so both report the same numbers.
import { scoreToGrade } from './grade'
import type { Inputs, RunResult } from './types'

export interface Kpis {
  worstWeek: number | null
  worstGrade: string
  worstChannel: string
  weeksBelowTarget: { voice: number; chat: number; email: number }
  peakUtilisation: number
  largestFteGap: { week: number; fte: number }
  worstEmailBacklogDays: number
  idleBorrowedHours: number
  freezeStart: number
  freezeEnd: number
  waveWeeks: number[]
  headcountFlows: RunResult['flows']
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`

export function kpis(inp: Inputs, r: RunResult): Kpis {
  const graded = r.weeks.filter((w) => Number.isFinite(w.score))
  const worst = graded.length ? graded.reduce((a, w) => (w.score < a.score ? w : a)) : null
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
  const gap = r.weeks.reduce((a, w) => (w.fteReq - w.fteAvail > a.fteReq - a.fteAvail ? w : a), r.weeks[0])
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
    largestFteGap: { week: gap.week, fte: Math.max(0, gap.fteReq - gap.fteAvail) },
    worstEmailBacklogDays: Math.max(0, ...r.weeks.map((w) => w.email.backlogDays)),
    idleBorrowedHours: r.weeks.reduce((s, w) => s + w.borrowedIdleHours, 0),
    freezeStart: r.freezeStart,
    freezeEnd: r.freezeEnd,
    waveWeeks: r.waveWeeks,
    headcountFlows: r.flows,
  }
}
