// Monte Carlo over the assumption register. Each draw samples every register entry that has a
// range (PERT), writes the values into a copy of the scenario and runs the weekly engine with
// attrition drawn rather than averaged. Every input has its own seeded stream, so answering one
// question does not reshuffle the others, and a scenario and its comparison see the same futures
// (common random numbers).

import { normaliseMixes, sampledBook } from './book'
import { DRAWN_BOOK_TRIPLES } from './questions'
import { run } from './engine'
import { mulberry32, pert } from './random'
import { QUESTIONS } from './questions'
import { drawn, mixOf, setPath, syncRegister } from './register'
import type { BookCurve, Inputs } from './types'

export const MC_METRICS = ['voice', 'chat', 'email', 'fteAvail', 'fteReq', 'heads'] as const
export type McMetric = (typeof MC_METRICS)[number]

export interface McBands {
  draws: number
  weeks: number
  p10: Record<McMetric, number[]>
  p50: Record<McMetric, number[]>
  p90: Record<McMetric, number[]>
  meetShare: number[] // per week: share of draws meeting every target
  cleanShare: number // share of draws in which no graded week misses a target or is capped by abandonment
  freezeEnd: { p10: number; p50: number; p90: number }
  trough: { week: number; p10: number; p50: number; p90: number } // each future's lowest weekly service on any channel; week = median week it happens
  bandWidth: number // mean p90 − p10 of service across scored weeks and channels: the headline 'how uncertain' measure
  drawnPaths: string[]
}

/** Stable 32-bit hash of a string (FNV-1a), for per-input random streams. */
export function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}
const stream = (seed: number, key: string, draw: number) => mulberry32((seed ^ hash32(key) ^ Math.imul(draw + 1, 0x9e3779b1)) >>> 0)

/**
 * Inputs answered by one question share a random stream (forecast error is a common shock),
 * except the shares of a mix: those draw independently and are then rescaled to sum to 1, so a
 * book's composition really is uncertain rather than moving as one block.
 */
const STREAM_KEY: Record<string, string> = {}
for (const q of QUESTIONS) if (q.sets.length > 1) for (const p of q.sets) if (!mixOf(p)) STREAM_KEY[p] = `q:${q.id}`

/** Book week ranges whose register status is "confirmed" are locked to their likely value in the simulation. */
export function lockConfirmedBookRanges(x: Inputs): void {
  for (const path of DRAWN_BOOK_TRIPLES) {
    if (x.assumptions[path]?.status !== 'confirmed') continue
    const lock = (t: [number, number, number]): [number, number, number] => [t[1], t[1], t[1]]
    if (path === 'book.exitNotice') x.book.exitNotice = { evergreen: lock(x.book.exitNotice.evergreen), tfc: lock(x.book.exitNotice.tfc) }
    else if (path === 'book.replatformOffset') x.book.replatformOffset = lock(x.book.replatformOffset)
    else x.book.waveSlip = lock(x.book.waveSlip)
  }
}

/** The values one future draws for every ranged register entry (the register is synced first). */
export function drawAssumptions(inp: Inputs, seed: number, draw: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [path, range] of drawn(inp)) out[path] = pert(stream(seed, STREAM_KEY[path] ?? path, draw), range)
  return out
}

/** Nearest-rank percentile of a sorted array, skipping NaN (unscored weeks). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))
  return sorted[i]
}

export function simulate(input: Inputs, draws: number, seed: number): McBands {
  const inp = structuredClone(input)
  syncRegister(inp) // draws must centre on the inputs as they are, whatever path changed them
  const W = inp.horizonWeeks
  const ranges = drawn(inp)
  const series: Record<McMetric, number[][]> = {
    voice: [], chat: [], email: [], fteAvail: [], fteReq: [], heads: [],
  }
  const worst: number[][] = []
  const meet = new Array(W).fill(0)
  const ends: number[] = []
  let clean = 0

  for (let d = 0; d < draws; d++) {
    const x = structuredClone(inp)
    let length = inp.freeze.endWeek - inp.freeze.startWeek
    for (const [path, v] of Object.entries(drawAssumptions(inp, seed, d))) {
      if (path === 'freeze.length') length = v
      else if (mixOf(path)) { const m = mixOf(path)!; (x.book[m.which] as unknown as Record<string, number>)[m.key] = v } // raw share; rescaled below
      else setPath(x, path, v)
    }
    const freezeEnd = Math.round(x.freeze.startWeek + length)
    ends.push(freezeEnd)
    // book mode: the mixes drawn above are rescaled to shares, then this future's own staircase is drawn
    let bookCurve: BookCurve | undefined
    if (x.book?.mode === 'book') {
      normaliseMixes(x)
      lockConfirmedBookRanges(x)
      bookCurve = sampledBook(x, freezeEnd, stream(seed, 'book', d))
    }
    const r = run(x, { rng: stream(seed, 'attrition', d), freezeEndOverride: freezeEnd, quantiseLoad: true, bookCurve })
    series.voice.push(r.weeks.map((w) => w.voice.sl))
    series.chat.push(r.weeks.map((w) => w.chat.sl))
    series.email.push(r.weeks.map((w) => w.email.timeliness))
    series.fteAvail.push(r.weeks.map((w) => w.fteAvail))
    series.fteReq.push(r.weeks.map((w) => w.fteReq))
    series.heads.push(r.weeks.map((w) => w.heads))
    worst.push(r.weeks.map((w) => {
      const xs = [w.voice.scored ? w.voice.sl : NaN, w.chat.scored ? w.chat.sl : NaN, w.email.scored ? w.email.timeliness : NaN].filter(Number.isFinite)
      return xs.length ? Math.min(...xs) : NaN
    }))
    r.weeks.forEach((w, i) => { if (w.meetsAll) meet[i]++ })
    if (r.weeks.every((w) => (w.meetsAll && !w.cappedByAbandonment) || !Number.isFinite(w.score))) clean++
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
  // each future's own trough: its worst week for its worst channel
  const lows = worst.map((s) => s.filter(Number.isFinite)).filter((s) => s.length).map((s) => Math.min(...s)).sort((a, b) => a - b)
  const lowWeeks = worst.map((s) => s.reduce((bi, x, i) => (Number.isFinite(x) && (bi < 0 || x < s[bi]) ? i : bi), -1)).filter((i) => i >= 0).sort((a, b) => a - b)
  return {
    trough: { week: percentile(lowWeeks, 0.5), p10: percentile(lows, 0.1), p50: percentile(lows, 0.5), p90: percentile(lows, 0.9) },
    bandWidth: (() => {
      let sum = 0
      let n = 0
      for (const m of ['voice', 'chat', 'email'] as const)
        for (let w = 0; w < W; w++) {
          const d = p90[m][w] - p10[m][w]
          if (Number.isFinite(d)) { sum += d; n++ }
        }
      return n ? sum / n : 0
    })(),
    drawnPaths: ranges.map(([p]) => p),
    draws,
    weeks: W,
    p10, p50, p90,
    meetShare: meet.map((x) => x / draws),
    cleanShare: clean / draws,
    freezeEnd: { p10: percentile(ends, 0.1), p50: percentile(ends, 0.5), p90: percentile(ends, 0.9) },
  }
}
