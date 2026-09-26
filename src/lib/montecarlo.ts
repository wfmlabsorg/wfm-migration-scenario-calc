// Monte Carlo over the uncertain inputs. Each draw samples the freeze length, the attrition
// multipliers, the absence surge and the runoff rate, then runs the weekly engine with
// attrition drawn rather than averaged. Seeded, so a scenario and its comparison see the
// same futures (common random numbers).

import { run } from './engine'
import { mulberry32, pert } from './random'
import type { Inputs } from './types'

export const MC_METRICS = ['voice', 'chat', 'email', 'fteAvail', 'fteReq', 'heads'] as const
export type McMetric = (typeof MC_METRICS)[number]

export interface McBands {
  draws: number
  weeks: number
  p10: Record<McMetric, number[]>
  p50: Record<McMetric, number[]>
  p90: Record<McMetric, number[]>
  meetShare: number[] // per week: share of draws meeting every target
  cleanShare: number // share of draws in which no graded week misses a target
  freezeEnd: { p10: number; p50: number; p90: number }
}

/** Nearest-rank percentile of a sorted array, skipping NaN (unscored weeks). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))
  return sorted[i]
}

export function simulate(inp: Inputs, draws: number, seed: number): McBands {
  const rng = mulberry32(seed)
  const W = inp.horizonWeeks
  const u = inp.uncertainty
  const series: Record<McMetric, number[][]> = {
    voice: [], chat: [], email: [], fteAvail: [], fteReq: [], heads: [],
  }
  const meet = new Array(W).fill(0)
  const ends: number[] = []
  let clean = 0

  for (let d = 0; d < draws; d++) {
    const length = pert(rng, u.freezeLength)
    const tensionMult = pert(rng, u.tensionMult)
    const postMult = pert(rng, u.postMult)
    const surgePts = pert(rng, u.surgePts)
    const runoffPctWeek = pert(rng, u.runoffPctWeek)
    const freezeEnd = Math.round(inp.freeze.startWeek + length)
    ends.push(freezeEnd)
    const r = run(inp, { rng, freezeEndOverride: freezeEnd, overrides: { tensionMult, postMult, surgePts, runoffPctWeek } })
    series.voice.push(r.weeks.map((w) => w.voice.sl))
    series.chat.push(r.weeks.map((w) => w.chat.sl))
    series.email.push(r.weeks.map((w) => w.email.timeliness))
    series.fteAvail.push(r.weeks.map((w) => w.fteAvail))
    series.fteReq.push(r.weeks.map((w) => w.fteReq))
    series.heads.push(r.weeks.map((w) => w.heads))
    r.weeks.forEach((w, i) => { if (w.meetsAll) meet[i]++ })
    if (r.weeks.every((w) => w.meetsAll || !Number.isFinite(w.score))) clean++
  }

  const empty = () => Object.fromEntries(MC_METRICS.map((m) => [m, [] as number[]])) as Record<McMetric, number[]>
  const p10 = empty(), p50 = empty(), p90 = empty()
  for (const m of MC_METRICS) {
    for (let w = 0; w < W; w++) {
      const col = series[m].map((s) => s[w]).filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
      p10[m].push(percentile(col, 0.1))
      p50[m].push(percentile(col, 0.5))
      p90[m].push(percentile(col, 0.9))
    }
  }
  ends.sort((a, b) => a - b)
  return {
    draws,
    weeks: W,
    p10, p50, p90,
    meetShare: meet.map((x) => x / draws),
    cleanShare: clean / draws,
    freezeEnd: { p10: percentile(ends, 0.1), p50: percentile(ends, 0.5), p90: percentile(ends, 0.9) },
  }
}
