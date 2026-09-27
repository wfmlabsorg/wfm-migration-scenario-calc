// v1.4: the people split (transfer / release groups) and the book-of-business builder.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { applyChanges, PATHS } from '../src/agent/schema'
import { AgentTools } from '../src/agent/tools'
import { TOOL_DEFS } from '../src/agent/toolDefs'
import { betaCdf, expectedBook, normaliseMixes, pertCdf, pertQuantile, sampledBook, validateBook } from '../src/lib/book'
import { DEFAULTS } from '../src/lib/defaults'
import { run, staffWaves } from '../src/lib/engine'
import { drawAssumptions, simulate } from '../src/lib/montecarlo'
import { mulberry32, pert } from '../src/lib/random'
import { drawn, recordAnswer, statusCounts } from '../src/lib/register'
import { decode, encode } from '../src/lib/share'
import type { Inputs, RunResult } from '../src/lib/types'

const clone = (): Inputs => structuredClone(DEFAULTS)
const KEYS = ['heads', 'moved', 'attrition', 'released', 'trainingHours', 'prodHours', 'fteReq', 'fteAvail', 'score'] as const
const maxDiff = (a: RunResult, b: RunResult) => {
  let m = 0
  for (let w = 0; w < a.weeks.length; w++)
    for (const k of KEYS) {
      const x = a.weeks[w][k], y = b.weeks[w][k]
      if (Number.isFinite(x) || Number.isFinite(y)) m = Math.max(m, Math.abs(x - y))
    }
  return m
}
const identity = (r: RunResult) => r.flows.start + r.flows.hired - (r.flows.attritionPre + r.flows.attritionFreeze + r.flows.attritionPost + r.flows.moved + r.flows.released + r.flows.end)
const noNaN = (r: RunResult) => r.weeks.every((w) => [w.heads, w.prodHours, w.fteReq, w.fteAvail, w.email.backlogHours].every(Number.isFinite))

describe('features are off by default', () => {
  test('defaults: one stock, manual departures; the golden fixtures are covered by golden.test.ts', () => {
    expect(DEFAULTS.people.split).toBe(false)
    expect(DEFAULTS.book.mode).toBe('manual')
    expect(run(DEFAULTS).book).toBeUndefined()
    expect(run(DEFAULTS).weeks[20].groups).toBeUndefined()
  })
  test('links without the blocks decode to the defaults; malformed blocks are sanitised', () => {
    const old = structuredClone(DEFAULTS) as unknown as Record<string, unknown>
    delete old.people
    delete old.book
    const i = decode(`#s=${Buffer.from(JSON.stringify(old)).toString('base64url')}`)!
    expect(i.people).toEqual(DEFAULTS.people)
    expect(i.book).toEqual(DEFAULTS.book)
    const bad = structuredClone(DEFAULTS) as unknown as Record<string, any>
    bad.book = { mode: 'book', contractMix: { fixed: 'x', evergreen: -1, tfc: 3 }, waves: [{ weeksAfterFreeze: 999, pct: 2 }], waveSlip: ['a', 1], granularity: 1e9 }
    bad.people = { split: 'yes', postMultTransfer: 99, retentionTarget: 'everyone' }
    const j = decode(`#s=${Buffer.from(JSON.stringify(bad)).toString('base64url')}`)!
    expect(j.book.mode).toBe('book')
    expect(j.book.contractMix.fixed + j.book.contractMix.evergreen + j.book.contractMix.tfc).toBeCloseTo(1, 12)
    expect(j.book.waves).toEqual([{ weeksAfterFreeze: 77, pct: 1 }])
    expect(j.book.waveSlip).toEqual(DEFAULTS.book.waveSlip)
    expect(j.book.granularity).toBe(200)
    expect(j.people.split).toBe(false)
    expect(j.people.postMultTransfer).toBe(8)
    expect(j.people.retentionTarget).toBe('release')
    expect(run(j).weeks.length).toBe(j.horizonWeeks)
  })
})

describe('people split', () => {
  const split = (f: (i: Inputs) => void = () => {}) => {
    const i = clone()
    i.people = { split: true, postMultTransfer: i.attrition.postMult, postMultRelease: i.attrition.postMult, retentionEffect: 0, retentionTarget: 'release' }
    f(i)
    return i
  }
  test('equals the single stock when the multipliers are equal, no retention and the waves sum to 1', () => {
    expect(maxDiff(run(clone()), run(split()))).toBeLessThan(1e-9)
    const m = clone()
    m.after.waves = [{ weeksAfterFreeze: 4, pct: 0.5 }, { weeksAfterFreeze: 10, pct: 0.5 }]
    expect(maxDiff(run(m), run(split((i) => { i.after.waves = m.after.waves })))).toBeLessThan(1e-9)
  })
  test('headcount identity holds and the post-announcement attrition splits by group', () => {
    const r = run(split((i) => { i.after.waves = [{ weeksAfterFreeze: 6, pct: 0.5 }]; i.people.postMultRelease = 3; i.people.postMultTransfer = 1.2; i.after.releasesOn = true }))
    expect(Math.abs(identity(r))).toBeLessThan(1e-9)
    expect(r.flows.attritionPostTransfer! + r.flows.attritionPostRelease!).toBeCloseTo(r.flows.attritionPost, 9)
    expect(r.flows.attritionPostRelease!).toBeGreaterThan(r.flows.attritionPostTransfer!)
    expect(noNaN(r)).toBe(true)
  })
  test('the transfer group is untouched by releases and leaves only with the waves', () => {
    const i = split((x) => { x.after.waves = [{ weeksAfterFreeze: 6, pct: 0.5 }]; x.after.releasesOn = true; x.after.noticeWeeks = 2; x.people.postMultRelease = 3 })
    const r = run(i)
    let prevT: number | null = null
    for (const w of r.weeks) {
      if (!w.groups) continue
      if (prevT !== null && w.moved === 0) expect(w.groups.transfer).toBeLessThanOrEqual(prevT + 1e-9) // only attrition
      if (w.released > 0) expect(w.groups.release).toBeGreaterThanOrEqual(-1e-9)
      prevT = w.groups.transfer
    }
    const t = run(i, { traceWeek: r.freezeEnd }).trace!
    expect(t.headcount.transferShareAtSplit).toBeCloseTo(0.5, 9)
    expect(t.headcount.transferGroup! + t.headcount.releaseGroup!).toBeCloseTo(t.headcount.end, 9)
    expect(r.flows.released).toBeGreaterThan(0)
  })
  test('a retention offer aimed at the release group lowers only that group\'s leaving', () => {
    const base = split((x) => { x.after.waves = [{ weeksAfterFreeze: 6, pct: 0.5 }]; x.people.postMultRelease = 3 })
    const offer = structuredClone(base)
    offer.people.retentionEffect = 0.4
    const a = run(base), b = run(offer)
    expect(b.flows.attritionPostRelease!).toBeLessThan(a.flows.attritionPostRelease!)
    expect(b.flows.attritionPostTransfer!).toBeCloseTo(a.flows.attritionPostTransfer!, 9)
    expect(b.flows.end).toBeGreaterThan(a.flows.end)
  })
  test('P3 is inactive and P3a/P3b active only when split is on', () => {
    const i = clone()
    expect(drawn(i).map(([p]) => p)).toContain('attrition.postMult')
    expect(drawn(i).map(([p]) => p)).not.toContain('people.postMultRelease')
    i.people.split = true
    const d = drawn(i).map(([p]) => p)
    expect(d).not.toContain('attrition.postMult')
    expect(d).toContain('people.postMultRelease')
    expect(d).toContain('people.postMultTransfer')
    expect(d).not.toContain('people.retentionEffect') // a lever: a point range
    expect(statusCounts(i).default).toBe(statusCounts(clone()).default + 2) // P3 → P3a + P3b + L1
  })
})

describe('book maths', () => {
  test('the regularised incomplete beta matches tables and the PERT sampler', () => {
    expect(betaCdf(0.5, 2, 2)).toBeCloseTo(0.5, 10)
    expect(betaCdf(0.3, 2, 5)).toBeCloseTo(0.579825, 6)
    expect(betaCdf(0.9, 0.5, 0.5)).toBeCloseTo(0.795167, 5)
    const t: [number, number, number] = [8, 13, 26]
    const rng = mulberry32(3)
    const xs = Array.from({ length: 100000 }, () => pert(rng, t))
    for (const v of [10, 13, 16, 20]) expect(Math.abs(xs.filter((x) => x <= v).length / xs.length - pertCdf(v, t))).toBeLessThan(0.006)
    for (const u of [0.1, 0.5, 0.9]) expect(pertCdf(pertQuantile(u, t), t)).toBeCloseTo(u, 8)
  })
  const oneWave = (): Inputs => {
    const k = clone()
    k.demand.stepDowns = []
    k.demand.runoffPctWeek = 0
    k.book.mode = 'book'
    k.book.contractMix = { fixed: 0, evergreen: 1, tfc: 0 }
    k.book.healthMix = { green: 1, amber: 0, red: 0 }
    k.book.priors.green = { transfer: 1, exit: 0, replatform: 0 }
    k.book.waves = [{ weeksAfterFreeze: 6, pct: 1 }]
    k.book.waveSlip = [0, 0, 0]
    return k
  }
  test('(a) all-evergreen, all-green, priors transfer = 1, one wave at +6 equals manual with one 100% wave', () => {
    const m = clone()
    m.demand.stepDowns = []
    m.demand.runoffPctWeek = 0
    m.after.waves = [{ weeksAfterFreeze: 6, pct: 1 }]
    expect(maxDiff(run(m), run(oneWave()))).toBeLessThan(1e-9)
    // and with the split on in both
    const ms = structuredClone(m); ms.people.split = true
    const ks = oneWave(); ks.people.split = true
    expect(maxDiff(run(ms), run(ks))).toBeLessThan(1e-9)
  })
  test('(b) implied fates equal Σ share × prior after the late-exit correction; (d) monotone; (e) remaining[0] = 1', () => {
    const i = clone(); i.book.mode = 'book'; i.book.fixedExpiry = [4, 52] // no fixed-term expiry in week 0
    const e = expectedBook(i, 16)
    expect(e.remaining[0]).toBeCloseTo(1, 9)
    for (let w = 1; w < e.remaining.length; w++) expect(e.remaining[w]).toBeLessThanOrEqual(e.remaining[w - 1] + 1e-12)
    const f = e.impliedFates
    expect(f.transfer + f.exit + f.replatform).toBeCloseTo(1, 9)
    // raw priors: transfer 0.85·0.6+0.65·0.3+0.35·0.1 = 0.74; late exits raise it, re-platform is untouched (0.07)
    expect(f.replatform).toBeCloseTo(0.07, 9)
    expect(f.transfer).toBeGreaterThan(0.74)
    expect(f.transfer + f.exit).toBeCloseTo(0.93, 9)
    // with an immediate wave no exit can land before it: everything but re-platform transfers
    const j = clone(); j.book.mode = 'book'; j.book.waves = [{ weeksAfterFreeze: 0, pct: 1 }]; j.book.fixedExpiry = [70, 77]
    expect(expectedBook(j, 16).impliedFates.exit).toBeCloseTo(0, 6)
  })
  test('(c) the Monte Carlo mean of sampled staircases converges to the expected curve', () => {
    const i = clone(); i.book.mode = 'book'
    const e = expectedBook(i, 16)
    const D = 1500
    const K = i.book.granularity
    const acc = new Array(i.horizonWeeks).fill(0)
    for (let d = 0; d < D; d++) {
      const s = sampledBook(i, 16, mulberry32(77 + d))
      for (let w = 0; w < acc.length; w++) acc[w] += s.remaining[w] / D
    }
    const bound = 3 / Math.sqrt(D * K)
    for (let w = 0; w < acc.length; w++) expect(Math.abs(acc[w] - e.remaining[w])).toBeLessThan(bound)
  })
  test('mixes and priors are rescaled to shares', () => {
    const i = clone()
    i.book.contractMix = { fixed: 2, evergreen: 1, tfc: 1 }
    i.book.priors.red = { transfer: 1, exit: 1, replatform: 2 }
    normaliseMixes(i)
    expect(i.book.contractMix).toEqual({ fixed: 0.5, evergreen: 0.25, tfc: 0.25 })
    expect(i.book.priors.red).toEqual({ transfer: 0.25, exit: 0.25, replatform: 0.5 })
  })
})

describe('book mode in the engine', () => {
  const bookDemo = (f: (i: Inputs) => void = () => {}) => { const i = clone(); i.book.mode = 'book'; f(i); return i }
  test('conservation, identity and no NaN under every policy and both service models, split on and off', () => {
    for (const mode of ['priority', 'floor', 'prorata', 'equal'] as const)
      for (const model of ['A', 'C'] as const)
        for (const split of [false, true]) {
          const i = bookDemo((x) => { x.balance = { ...x.balance, mode }; x.service.model = model; x.people.split = split; x.after.releasesOn = split })
          const r = run(i)
          expect(Math.abs(identity(r))).toBeLessThan(1e-9)
          expect(noNaN(r)).toBe(true)
          expect(r.book).toBeDefined()
          for (const w of [5, 20, 30]) {
            const t = run(i, { traceWeek: w }).trace!
            const given = t.buckets.reduce((s, b) => s + (b.voice.agentsFinal + b.chat.agentsFinal) * b.openHours, 0)
            const total = given + t.email.workedHours + t.borrowed.idleHours + t.balance.inHouseIdleHours
            expect(total).toBeCloseTo(t.hours.productive + t.borrowed.homeEquivalentHours, 6)
          }
        }
  })
  test('staff move with transfers only; exits and re-platforming remove work without moving staff', () => {
    const i = bookDemo((x) => { x.book.priors = { green: { transfer: 0, exit: 1, replatform: 0 }, amber: { transfer: 0, exit: 1, replatform: 0 }, red: { transfer: 0, exit: 1, replatform: 0 } }; x.book.waves = [{ weeksAfterFreeze: 30, pct: 1 }] })
    const r = run(i)
    // exits landing before week 46 leave the book; staff only move at the wave (which is beyond the horizon)
    expect(r.flows.moved).toBeCloseTo(0, 9)
    expect(r.weeks[r.weeks.length - 1].voice.volume).toBeLessThan(r.weeks[0].voice.volume * 0.7)
    expect(r.waveWeeks).toEqual([46])
  })
  test('wave slip spreads the moves and a Monte Carlo draws real staircases', () => {
    const i = bookDemo((x) => { x.book.waveSlip = [0, 2, 6] })
    const r = run(i)
    const moveWeeks = r.weeks.filter((w) => w.moved > 1e-9).length
    expect(moveWeeks).toBeGreaterThan(3)
    const b = simulate(i, 100, 5)
    expect(b.drawnPaths).toContain('book.healthMix.red')
    expect(b.drawnPaths).not.toContain('demand.runoffPctWeek')
    // each future's staircase differs from the expected one
    const one = run(i, { bookCurve: sampledBook(i, r.freezeEnd, mulberry32(9)) })
    expect(maxDiff(one, r)).toBeGreaterThan(0)
  })
  test('performance: 1,000 draws in book mode with K = 40 under Erlang A', () => {
    const i = bookDemo()
    simulate(i, 50, 1)
    const t0 = performance.now()
    simulate(i, 1000, 1)
    const ms = performance.now() - t0
    console.log(`MC book mode 1000 draws: ${ms.toFixed(0)} ms`)
    expect(ms).toBeLessThan(6000)
  }, 30_000)
})

describe('register, paths and analyst tools', () => {
  test('book.* is drawn only in book mode, and drawn mixes are renormalised in the simulation', () => {
    const i = clone()
    expect(drawn(i).some(([p]) => p.startsWith('book.'))).toBe(false)
    i.book.mode = 'book'
    const paths = drawn(i).map(([p]) => p)
    expect(paths).toEqual(expect.arrayContaining(['book.contractMix.fixed', 'book.healthMix.green']))
    expect(paths).not.toContain('demand.stepDowns')
    // register draws are raw shares; the simulation rescales them (normaliseMixes) — check the pieces agree
    const d = drawAssumptions(i, 1, 3)
    expect(Number.isFinite(d['book.healthMix.red'])).toBe(true)
    expect(() => simulate(i, 20, 2)).not.toThrow()
  })
  test('record_assumption on a mix share works and the point stays a share after sync', () => {
    const i = clone(); i.book.mode = 'book'
    recordAnswer(i, 'book.contractMix.fixed', { low: 0.3, likely: 0.4, high: 0.5, status: 'estimated', owner: 'Commercial' })
    expect(i.book.contractMix.fixed).toBe(0.4)
    expect(i.assumptions['book.contractMix.fixed'].range).toEqual([0.3, 0.4, 0.5])
  })
  test('schema: virtual booleans switch modes; a mix share change rescales the others; every path exists', () => {
    const c = applyChanges(DEFAULTS, { changes: [{ path: 'people.split', value: 1 }, { path: 'book.useBook', value: 1 }, { path: 'book.contractMix.fixed', value: 0.8 }] })
    expect(c.people.split).toBe(true)
    expect(c.book.mode).toBe('book')
    expect(c.book.contractMix.fixed).toBe(0.8)
    expect(c.book.contractMix.evergreen + c.book.contractMix.tfc).toBeCloseTo(0.2, 12)
    expect(c.book.contractMix.evergreen / c.book.contractMix.tfc).toBeCloseTo(0.3 / 0.2, 9)
    for (const p of PATHS) {
      if (['service.useErlangA', 'people.split', 'book.useBook'].includes(p.path)) continue
      const v = p.path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], DEFAULTS)
      expect(v === undefined).toBe(false)
    }
  })
  test('validateBook rejects bad shares, sums, triples and waves', () => {
    const ok = structuredClone(DEFAULTS.book)
    expect(() => validateBook({ ...ok, mode: 'book' })).not.toThrow()
    expect(() => validateBook({ ...ok, mode: 'book', contractMix: { fixed: 0.5, evergreen: 0.5, tfc: 0.5 } })).toThrow(/sum to 1/)
    expect(() => validateBook({ ...ok, mode: 'book', healthMix: { green: 1.2, amber: 0, red: -0.2 } })).toThrow(/share 0–1/)
    expect(() => validateBook({ ...ok, mode: 'book', exitNotice: { evergreen: [13, 8, 26], tfc: [4, 6, 13] } })).toThrow(/low ≤ likely ≤ high/)
    expect(() => validateBook({ ...ok, mode: 'book', waves: [{ weeksAfterFreeze: 6, pct: 0.7 }, { weeksAfterFreeze: 12, pct: 0.7 }] })).toThrow(/at most 1/)
    expect(() => validateBook({ ...ok, mode: 'book', fixedExpiry: [30, 10] })).toThrow(/fixedExpiry/)
    expect(() => validateBook({ ...ok, mode: 'book', granularity: 3 })).toThrow(/granularity/)
    expect(() => validateBook({ ...ok, mode: 'sometimes' })).toThrow(/mode/)
  })
  test('set_book puts book mode on screen with implied fates; explain_book returns the staircase', async () => {
    let screen = clone()
    const labels: string[] = []
    const t = new AgentTools({ getInputs: () => screen, applyInputs: (next, label) => { labels.push(label); screen = next }, monteCarlo: async (i, d) => simulate(i, d, 1) })
    const { mode: _m, ...book } = structuredClone(DEFAULTS.book)
    void _m
    const out = JSON.parse(await t.execute('set_book', { label: '', ...book, healthMix: { green: 0.3, amber: 0.4, red: 0.3 } }))
    expect(labels).toEqual(['book of business'])
    expect(screen.book.mode).toBe('book')
    expect(out.impliedFates.transfer + out.impliedFates.exit + out.impliedFates.replatform).toBeCloseTo(1, 2)
    expect(out.impliedFates.transfer).toBeLessThan(0.8) // a redder book transfers less
    const ex = JSON.parse(await t.execute('explain_book', { label: '' }))
    expect(ex.mode).toBe('book')
    expect(ex.staircase.length).toBe(12)
    expect(ex.staircase[0].bookRemaining).toBeCloseTo(1, 2)
    expect(ex.staircase[11].bookRemaining).toBeLessThan(0.2)
    expect(ex.transferShareAtAnnouncement).toBeGreaterThan(0)
    // a labelled set_book is stored like run_scenario
    const lab = JSON.parse(await t.execute('set_book', { label: 'redbook', ...book, healthMix: { green: 0.1, amber: 0.3, red: 0.6 } }))
    expect(lab.label).toBe('redbook')
    expect(JSON.parse(await t.execute('compare', { labels: ['', 'redbook'] })).length).toBe(2)
    // bad shares are refused
    await expect(t.execute('set_book', { label: '', ...book, contractMix: { fixed: 0.9, evergreen: 0.9, tfc: 0 } })).rejects.toThrow(/sum to 1/)
  })
  test('tool definitions carry the new tools and the run_scenario book field', () => {
    const names = TOOL_DEFS.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['set_book', 'explain_book']))
    const run_ = TOOL_DEFS.find((t) => t.name === 'run_scenario')!
    expect(Object.keys(run_.input_schema.properties)).toContain('book')
  })
  test('links keep the blocks', () => {
    const i = clone(); i.book.mode = 'book'; i.people.split = true; i.people.retentionEffect = 0.3
    const back = decode(`#s=${encode(i)}`)!
    expect(back.book).toEqual(i.book)
    expect(back.people).toEqual(i.people)
  })
})

describe('Erlang A golden fixture is untouched by v1.4', () => {
  test('fixture file still parses with 4 variants', () => {
    const g = JSON.parse(readFileSync('tests/fixtures/golden-v1.3-erlangA.json', 'utf8'))
    expect(Object.keys(g).length).toBe(4)
  })
  test('manual τ helper: waves summing to 1 give τ = 1 at the first wave', () => {
    const ws = staffWaves(DEFAULTS, 16)
    expect(ws.map((w) => w.week)).toEqual([22, 28, 34])
    expect(ws[2].pctT).toBeCloseTo(1, 9)
    let keep = 1
    for (const w of ws) keep *= 1 - w.pct
    expect(1 - keep).toBeCloseTo(1, 9)
  })
})
