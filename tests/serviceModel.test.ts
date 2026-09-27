import { describe, expect, test } from 'bun:test'
import { DEFAULTS } from './legacyDemo'
import { run } from '../src/lib/engine'
import { simulate } from '../src/lib/montecarlo'
import { decode, encode } from '../src/lib/share'
import type { Inputs } from '../src/lib/types'

const withModel = (model: 'A' | 'C', f: (i: Inputs) => void = () => {}): Inputs => {
  const i = structuredClone(DEFAULTS)
  i.service.model = model
  f(i)
  return i
}
const short = (i: Inputs) => {
  i.pool.fte = 200
  i.balance = { ...i.balance, mode: 'prorata' }
}

describe('Erlang C mode ignores the Erlang A settings', () => {
  test('patience, redial and the abandonment cap change nothing', () => {
    const a = run(withModel('C'))
    const b = run(withModel('C', (i) => { i.service = { model: 'C', patience: { voice: 7, chat: 9000 }, redialRate: 1, abandonCap: 0.01 } }))
    const diffs: string[] = []
    a.weeks.forEach((w, k) => {
      for (const key of ['score', 'fteReq', 'fteAvail'] as const) if (!Object.is(w[key], b.weeks[k][key])) diffs.push(`${k}.${key}`)
      if (!Object.is(w.voice.sl, b.weeks[k].voice.sl) || !Object.is(w.email.backlogHours, b.weeks[k].email.backlogHours)) diffs.push(`${k}.service`)
      expect(w.voice.abandoned).toBe(0)
    })
    expect(diffs).toEqual([])
  })
})

describe('share links', () => {
  test('links made before v1.2 (no service field) decode to Erlang C', () => {
    const legacy = { ...structuredClone(DEFAULTS) } as Partial<Inputs>
    delete legacy.service
    const hash = Buffer.from(JSON.stringify(legacy)).toString('base64url')
    expect(decode(`#s=${hash}`)!.service.model).toBe('C')
  })
  test('new links keep their model', () => {
    expect(decode(`#s=${encode(withModel('A'))}`)!.service.model).toBe('A')
    expect(decode(`#s=${encode(withModel('C'))}`)!.service.model).toBe('C')
  })
})

describe('abandonment and retries', () => {
  const i = withModel('A', short)
  const r = run(i)
  test('the neutral demo has no extra retries while service holds at week-0 levels', () => {
    const n = withModel('A', (x) => { x.after.waves = []; x.demand.runoffPctWeek = 0; x.demand.stepDowns = []; x.attrition.annual = 0; x.after.surgePts = 0; x.after.trainingHours = 0 })
    for (const w of run(n).weeks) expect(w.voice.retriesIn + w.chat.retriesIn).toBeCloseTo(0, 9)
  })
  test('retries out of one week arrive in the next, scaled by the book still here', () => {
    const book = run(withModel('A', (x) => { short(x); x.service.redialRate = 0 })) // forecast volumes, no retries
    let checked = 0
    for (const w of [3, 10, 17, 20, 30]) {
      const t0 = run(i, { traceWeek: w }).trace!
      const t1 = run(i, { traceWeek: w + 1 }).trace!
      for (const ch of ['voice', 'chat'] as const) {
        const stay = Math.min(1, book.weeks[w + 1][ch].volume / book.weeks[w][ch].volume)
        expect(t1.service.retriesIn[ch]).toBeCloseTo(t0.service.retriesOut[ch] * stay, 6)
        expect(r.weeks[w + 1][ch].volume).toBeCloseTo(book.weeks[w + 1][ch].volume + t1.service.retriesIn[ch], 6)
        if (t0.service.retriesOut[ch] > 0) checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
  })
  test('retries are the redial share of abandonment above the week-0 rate', () => {
    const r0 = { voice: r.weeks[0].voice.abandonRate, chat: r.weeks[0].chat.abandonRate }
    const t = run(i, { traceWeek: 12 }).trace!
    const w = r.weeks[12]
    expect(t.service.retriesOut.voice).toBeCloseTo(Math.max(0, w.voice.abandoned - r0.voice * w.voice.volume) * i.service.redialRate, 6)
    expect(t.service.retriesOut.chat).toBeCloseTo(Math.max(0, w.chat.abandoned - r0.chat * w.chat.volume) * i.service.redialRate, 6)
  })
  test('abandoned = volume × rate, and weekly figures reconcile with the trace buckets', () => {
    for (const k of [0, 8, 15, 25]) {
      const t = run(i, { traceWeek: k }).trace!
      const w = r.weeks[k]
      const vs = i.profile.volumeShare
      expect(w.voice.abandoned).toBeCloseTo(w.voice.volume * w.voice.abandonRate, 6)
      expect(w.voice.sl).toBeCloseTo(t.buckets.reduce((s, b, j) => s + vs[j] * b.voice.serviceLevel, 0), 9)
      expect(w.voice.abandonRate).toBeCloseTo(t.buckets.reduce((s, b, j) => s + vs[j] * b.voice.abandonRate, 0), 9)
      expect(w.chat.abandonRate).toBeCloseTo(t.buckets.reduce((s, b, j) => s + vs[j] * b.chat.abandonRate, 0), 9)
    }
  })
  test('service level never exceeds the answered share, and nothing is NaN while scored', () => {
    for (const w of r.weeks)
      for (const ch of [w.voice, w.chat])
        if (ch.scored) {
          expect(Number.isFinite(ch.sl) && Number.isFinite(ch.abandonRate)).toBe(true)
          expect(ch.sl).toBeLessThanOrEqual(1 - ch.abandonRate + 1e-9)
        }
  })
  test('an Erlang A queue is never flagged unstable', () => {
    expect(r.weeks.some((w) => w.voice.unstable || w.chat.unstable)).toBe(false)
  })
  test('overloaded queues still give some service under A, none under C', () => {
    const c = run(withModel('C', short))
    const worst = (x: typeof r) => Math.min(...x.weeks.filter((w) => w.chat.scored).map((w) => w.chat.sl))
    expect(worst(c)).toBeLessThan(0.05)
    expect(worst(r)).toBeGreaterThan(worst(c) + 0.1)
  })
})

describe('grade cap', () => {
  const i = withModel('A', short)
  test('above the cap the week is BBB at best, above twice the cap CCC at best', () => {
    const seen = { none: 0, bbb: 0, ccc: 0 }
    for (let w = 0; w < i.horizonWeeks; w += 2) {
      const g = run(i, { traceWeek: w }).trace!.grade
      if (Number.isNaN(g.scoreBeforeCap)) continue
      if (g.worstAbandonRate > 2 * g.abandonCap) {
        expect(g.score).toBe(Math.min(g.scoreBeforeCap, 0.39))
        seen.ccc++
      } else if (g.worstAbandonRate > g.abandonCap) {
        expect(g.score).toBe(Math.min(g.scoreBeforeCap, 0.69))
        seen.bbb++
      } else {
        expect(g.score).toBe(g.scoreBeforeCap)
        seen.none++
      }
    }
    expect(seen.none + seen.bbb + seen.ccc).toBeGreaterThan(10)
    expect(seen.bbb + seen.ccc).toBeGreaterThan(0)
  })
  test('raising the cap lifts the cap', () => {
    const loose = run(withModel('A', (x) => { short(x); x.service.abandonCap = 1 }))
    const tight = run(i)
    loose.weeks.forEach((w, k) => { if (!Number.isNaN(w.score)) expect(w.score).toBeGreaterThanOrEqual(tight.weeks[k].score) })
  })
})

describe('performance under Erlang A', () => {
  test('a 78-week run takes under 50 ms (warm)', () => {
    const i = withModel('A', (x) => { x.horizonWeeks = 78 })
    run(i)
    const t0 = performance.now()
    run(i)
    expect(performance.now() - t0).toBeLessThan(50)
  })
  test('200 Monte Carlo draws finish in a few seconds', () => {
    const t0 = performance.now()
    simulate(withModel('A'), 200, 3)
    const ms = performance.now() - t0
    console.log(`MC 200 draws under A: ${ms.toFixed(0)} ms`)
    expect(ms).toBeLessThan(5000)
  }, 20_000)
})
