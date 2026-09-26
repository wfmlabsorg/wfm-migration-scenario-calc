// Round-5 fixes to book mode and the split (audit 4): intake, single-stock/split consistency,
// mix draws, mix answers, card ranges, discrete expiry, implied fates, releases under training,
// trace rates, K, multipliers, confirmed book ranges, warnings, backlog, levers, CSV.
import { describe, expect, test } from 'bun:test'
import { applyChanges, PATHS } from '../src/agent/schema'
import { AgentTools } from '../src/agent/tools'
import { expectedBook, pertQuantile, sampledBook, sanitiseBook, staffWavesFrom } from '../src/lib/book'
import { toCsv } from '../src/lib/csv'
import { DEFAULTS } from '../src/lib/defaults'
import { run } from '../src/lib/engine'
import { drawAssumptions, lockConfirmedBookRanges, simulate } from '../src/lib/montecarlo'
import { PATH_META } from '../src/lib/questions'
import { mulberry32, pert } from '../src/lib/random'
import { drawn, getPath, recordAnswer, setPath } from '../src/lib/register'
import { checkCard, fromShapeCard, toShapeCard } from '../src/lib/shapeCard'
import type { Inputs, RunResult } from '../src/lib/types'

const clone = (): Inputs => structuredClone(DEFAULTS)
const book = (f: (i: Inputs) => void = () => {}): Inputs => { const i = clone(); i.book.mode = 'book'; f(i); return i }
const MIX = ['book.contractMix.fixed', 'book.contractMix.evergreen', 'book.contractMix.tfc', 'book.healthMix.green', 'book.healthMix.amber', 'book.healthMix.red']
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

describe('F1 intake in book mode replaces exits and re-platforming only', () => {
  test('with intake on, volume still goes to zero once every client has transferred or left', () => {
    const i = book((x) => { x.demand.intakeOn = true; x.demand.intakePct = 1; x.service.model = 'C' })
    const r = run(i)
    const last = r.weeks[r.weeks.length - 1]
    expect(last.voice.volume).toBeLessThan(1e-6)
    // before the first wave nothing has transferred: intake refills every exit, so volume holds at 100%
    expect(r.weeks[16].voice.volume / r.weeks[0].voice.volume).toBeCloseTo(1, 6)
    // after a wave the refilled share is scaled by the non-transferred share, as in manual mode
    const off = book((x) => { x.service.model = 'C' })
    const ro = run(off)
    expect(r.weeks[26].voice.volume).toBeGreaterThan(ro.weeks[26].voice.volume)
    expect(r.weeks[26].voice.volume).toBeLessThan(r.weeks[0].voice.volume)
  })
})

describe('F2 one stock and the split describe the same staff moves in book mode', () => {
  test('equal multipliers, no offer, no releases: identical to 1e-9 with exits and re-platforming present', () => {
    const i = book()
    const s = book((x) => { x.people = { split: true, postMultTransfer: x.attrition.postMult, postMultRelease: x.attrition.postMult, retentionEffect: 0, retentionTarget: 'release' } })
    expect(run(i).book!.impliedFates.exit).toBeGreaterThan(0.05)
    expect(maxDiff(run(i), run(s))).toBeLessThan(1e-9)
  })
  test('the staff of exited clients stay: the last wave never takes everyone when the book has exits', () => {
    const r = run(book())
    const waves = staffWavesFrom(r.book!)
    expect(waves[waves.length - 1].pct).toBeLessThan(1)
    expect(waves[waves.length - 1].pctOfTransferGroup).toBeCloseTo(1, 9)
    expect(r.flows.end).toBeGreaterThan(0) // they are still here at the end (no releases in the demo)
    expect(Math.abs(identity(r))).toBeLessThan(1e-9)
  })
  test('all transfers: the last wave takes everyone, as before', () => {
    const r = run(book((x) => { for (const h of ['green', 'amber', 'red'] as const) x.book.priors[h] = { transfer: 1, exit: 0, replatform: 0 } }))
    const waves = staffWavesFrom(r.book!)
    expect(waves[waves.length - 1].pct).toBeCloseTo(1, 9)
  })
})

describe('F3 mix shares draw independently', () => {
  test('raw draws of the three contract shares are not perfectly correlated', () => {
    const i = book()
    const xs: number[] = [], ys: number[] = []
    for (let d = 0; d < 300; d++) { const v = drawAssumptions(i, 5, d); xs.push(v['book.contractMix.fixed']); ys.push(v['book.contractMix.evergreen']) }
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length
    const mx = mean(xs), my = mean(ys)
    const corr = mean(xs.map((x, k) => (x - mx) * (ys[k] - my))) / Math.sqrt(mean(xs.map((x) => (x - mx) ** 2)) * mean(ys.map((y) => (y - my) ** 2)))
    expect(Math.abs(corr)).toBeLessThan(0.3)
  })
  test('confirming B1 and B3 narrows the drawn book: implied transfer share spread falls', () => {
    // the shares themselves: with independent draws the normalised fixed share keeps most of its width
    const i = book()
    const sds = (inp: Inputs) => {
      const vals: number[] = []
      for (let d = 0; d < 400; d++) {
        const x = structuredClone(inp)
        for (const [p, v] of Object.entries(drawAssumptions(inp, 5, d))) if (MIX.includes(p)) { const [, which, key] = p.split('.'); (x.book[which as 'contractMix'] as unknown as Record<string, number>)[key] = v }
        const s = x.book.healthMix.green + x.book.healthMix.amber + x.book.healthMix.red
        vals.push(x.book.healthMix.red / s)
      }
      const m = vals.reduce((a, b) => a + b, 0) / vals.length
      return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length)
    }
    expect(sds(i)).toBeGreaterThan(0.04) // was 0.006–0.03 with one shared stream
    const j = structuredClone(i)
    for (const p of MIX) recordAnswer(j, p, { likely: getPath(j, p), status: 'confirmed' })
    expect(drawn(j).some(([p]) => MIX.includes(p))).toBe(false)
    // In the demo book most exits land after their wave and transfer instead, so the mixes barely move
    // the curve and K noise dominates the bands. In a book whose exits land before the (single, late)
    // wave, the mixes matter, and confirming them narrows the late headcount band at fine granularity.
    const fine = (inp: Inputs) => {
      const x = structuredClone(inp)
      x.horizonWeeks = 52; x.book.granularity = 200; x.book.waves = [{ weeksAfterFreeze: 22, pct: 1 }]
      for (const [p] of drawn(x)) if (!MIX.includes(p)) recordAnswer(x, p, { likely: getPath(x, p), status: 'confirmed' })
      return x
    }
    const a = simulate(fine(i), 300, 5), b = simulate(fine(j), 300, 5)
    const spread = (m: typeof a, w: number) => m.p90.heads[w] - m.p10.heads[w]
    expect(spread(b, 40)).toBeLessThan(spread(a, 40) - 1)
    expect(b.bandWidth).toBeLessThanOrEqual(a.bandWidth + 1e-9)
  }, 60_000)
})

describe('F4 answering a mix share rescales its siblings', () => {
  test('recordAnswer keeps the mix summing to 1 and the recorded likely; the register follows', () => {
    const i = book()
    recordAnswer(i, 'book.healthMix.red', { likely: 0.5, status: 'estimated', low: 0.4, high: 0.6 })
    const m = i.book.healthMix
    expect(m.green + m.amber + m.red).toBeCloseTo(1, 12)
    expect(m.red).toBe(0.5)
    expect(m.green / m.amber).toBeCloseTo(2, 9) // siblings keep their proportion
    expect(i.assumptions['book.healthMix.green'].range![1]).toBeCloseTo(m.green, 12)
    expect(i.assumptions['book.healthMix.green'].status).toBe('default')
    // same through the analyst's applyChanges
    const j = applyChanges(book(), { changes: [{ path: 'book.contractMix.fixed', value: 0.8 }] })
    expect(j.book.contractMix.fixed + j.book.contractMix.evergreen + j.book.contractMix.tfc).toBeCloseTo(1, 12)
    expect(j.assumptions['book.contractMix.tfc'].range![1]).toBeCloseTo(j.book.contractMix.tfc, 12)
    // setPath on a mix path rescales too
    const k = book(); setPath(k, 'book.contractMix.tfc', 1)
    expect(k.book.contractMix.fixed + k.book.contractMix.evergreen).toBeCloseTo(0, 12)
  })
})

describe('F5 cards carry no absolute ranges and sanitise the book on import', () => {
  test('an absolute volume range is refused; a relative one is accepted and clamped', () => {
    const c = JSON.parse(JSON.stringify(toShapeCard(clone()))) as Record<string, any>
    expect(checkCard(c)).toBeNull()
    const bad = structuredClone(c); bad.assumptions['channels.voice.volume'] = { range: [29000, 30820, 33000], status: 'estimated' }
    expect(checkCard(bad)).toMatch(/absolute range/)
    const bad2 = structuredClone(c); bad2.assumptions['borrowed.fte'] = { range: [10, 20, 30], status: 'estimated' }
    expect(checkCard(bad2)).toMatch(/absolute range/)
    const ok = structuredClone(c); ok.assumptions['channels.voice.volume'] = { range: [0.9, 1, 1.1], status: 'estimated' }
    const i = fromShapeCard(ok, 250)
    const r = i.assumptions['channels.voice.volume'].range!
    expect(r[1]).toBe(i.channels.voice.volume)
    expect(r[0] / r[1]).toBeCloseTo(0.9, 6)
  })
  test('out-of-range book values are refused by the guard and clamped by sanitising', () => {
    const c = JSON.parse(JSON.stringify(toShapeCard(book()))) as Record<string, any>
    const bad = structuredClone(c); bad.scenario.book.waveSlip = [0, 40, 100]
    expect(checkCard(bad)).toMatch(/waveSlip/)
    const bad2 = structuredClone(c); bad2.scenario.book.fixedExpiry = [150.5, 199]
    expect(checkCard(bad2)).toMatch(/fixedExpiry/)
    const s = sanitiseBook({ ...book().book, waveSlip: [0, 40, 100], exitNotice: { evergreen: [1, 2.5, 300], tfc: [4, 6, 13] } }, book().book)
    expect(s.waveSlip).toEqual([0, 26, 26])
    expect(s.exitNotice.evergreen).toEqual([1, 3, 104]) // whole weeks, clamped
  })
})

describe('F6 fixed-term expiry is a discrete uniform over whole weeks', () => {
  test('a 3-week window puts a third of the mass on each week in the sampler and the closed form', () => {
    const i = book((x) => { x.book.contractMix = { fixed: 1, evergreen: 0, tfc: 0 }; x.book.healthMix = { green: 1, amber: 0, red: 0 }; x.book.priors.green = { transfer: 0, exit: 1, replatform: 0 }; x.book.fixedExpiry = [10, 12] })
    const acc = [0, 0, 0]
    const D = 3000
    for (let d = 0; d < D; d++) { const s = sampledBook(i, 16, mulberry32(d)); for (let k = 0; k < 3; k++) acc[k] += s.exitLeaving[10 + k] / D }
    const e = expectedBook(i, 16)
    for (let k = 0; k < 3; k++) {
      expect(e.exitLeaving[10 + k]).toBeCloseTo(1 / 3, 9)
      expect(Math.abs(acc[k] - 1 / 3)).toBeLessThan(0.03)
    }
  })
})

describe('F7 implied fates are the whole book\'s odds', () => {
  const meanFates = (i: Inputs, fe: number, D = 2000) => {
    const m = { transfer: 0, exit: 0, replatform: 0 }
    for (let d = 0; d < D; d++) { const s = sampledBook(i, fe, mulberry32(d)); m.transfer += s.impliedFates.transfer / D; m.exit += s.impliedFates.exit / D; m.replatform += s.impliedFates.replatform / D }
    return m
  }
  test('freeze end beyond the horizon: closed form matches the sampler', () => {
    const i = book()
    const e = expectedBook(i, 50).impliedFates
    const m = meanFates(i, 50)
    for (const k of ['transfer', 'exit', 'replatform'] as const) expect(Math.abs(e[k] - m[k])).toBeLessThan(3 / Math.sqrt(2000 * 40) + 0.005)
  })
  test('no waves: transfers count as transfers that never leave; exits and re-platforming keep their odds', () => {
    const i = book((x) => { x.book.waves = [] })
    const e = expectedBook(i, 16).impliedFates
    expect(e.transfer).toBeCloseTo(0.74, 9)
    expect(e.exit).toBeCloseTo(0.19, 9)
    expect(e.replatform).toBeCloseTo(0.07, 9)
    const m = meanFates(i, 16)
    expect(Math.abs(m.transfer - 0.74)).toBeLessThan(0.02)
    expect(run(i).book!.remaining[38]).toBeGreaterThan(0.7) // the transfers stay
  })
  test('slip pushing waves past the horizon: closed form matches the sampler and warns', () => {
    const i = book((x) => { x.book.waves = [{ weeksAfterFreeze: 20, pct: 1 }]; x.book.waveSlip = [0, 4, 8] })
    const e = expectedBook(i, 16).impliedFates
    const m = meanFates(i, 16)
    expect(Math.abs(e.transfer - m.transfer)).toBeLessThan(0.02)
    expect(run(i).warnings.some((w) => /beyond the horizon/.test(w))).toBe(true)
  })
})

describe('F8 releases never leave the team short, split on with heavy training', () => {
  test('property: released > 0 ⇒ fteAvail ≥ fteReq, across policies, modes and training loads', () => {
    let checked = 0
    for (const mode of ['book', 'manual'] as const)
      for (const policy of ['priority', 'floor', 'prorata', 'equal'] as const)
        for (const [hours, weeks, fte] of [[57.5, 1, 197], [120, 2, 230], [24, 4, 260]] as const) {
          const i = clone()
          i.book.mode = mode
          i.balance = { ...i.balance, mode: policy }
          i.pool.fte = fte
          i.horizonWeeks = 55
          i.after.releasesOn = true
          i.after.trainingHours = hours
          i.after.trainingWeeks = weeks
          i.after.surgePts = 0.17
          i.people = { split: true, postMultTransfer: 1.2, postMultRelease: 3, retentionEffect: 0, retentionTarget: 'release' }
          const r = run(i)
          for (const w of r.weeks) if (w.released > 1e-9) { checked++; expect(w.fteAvail).toBeGreaterThanOrEqual(w.fteReq - 1e-6) }
          expect(Math.abs(identity(r))).toBeLessThan(1e-6)
        }
    expect(checked).toBeGreaterThan(5)
  })
})

describe('F9 the trace shows the rates each group used', () => {
  test('after the split, transferRate × T + releaseRate × R reproduces the week\'s leavers', () => {
    const i = clone()
    i.people = { split: true, postMultTransfer: 1.2, postMultRelease: 3, retentionEffect: 0.5, retentionTarget: 'release' }
    const t = run(i, { traceWeek: 20 }).trace!.headcount
    expect(t.transferRate).toBeCloseTo((i.attrition.annual / 52) * 1.2, 12)
    expect(t.releaseRate).toBeCloseTo((i.attrition.annual / 52) * 3 * 0.5, 12)
    expect(t.lostTransfer! + t.lostRelease!).toBeCloseTo(t.lost, 9)
    expect(t.transferMultiplier).toBe(1.2)
    expect(t.retentionEffect).toEqual({ transfer: 0, release: 0.5 })
    expect(t.lost).toBeLessThan(t.start * t.attritionRate * 0.8) // the single-stock rate would have overstated the leavers
  })
})

describe('F10/F11 granularity and multipliers', () => {
  test('K is an analyst path; band width from the book falls as K rises', () => {
    expect(PATHS.find((p) => p.path === 'book.granularity')).toBeDefined()
    const base = book()
    for (const [p] of drawn(base)) recordAnswer(base, p, { likely: getPath(base, p), status: 'confirmed' })
    const w = (K: number) => { const x = structuredClone(base); x.book.granularity = K; return simulate(x, 200, 5).bandWidth }
    const w5 = w(5), w200 = w(200)
    expect(w200).toBeLessThan(w5 * 0.7)
  }, 30_000)
  test('the transfer group may be calmer than baseline, and unanswered multiplier ranges are unbiased', () => {
    const i = clone()
    i.people.split = true
    setPath(i, 'people.postMultTransfer', 0.5)
    expect(i.people.postMultTransfer).toBe(0.5)
    expect(() => applyChanges(clone(), { changes: [{ path: 'people.postMultTransfer', value: 0.7 }] })).not.toThrow()
    for (const [p, m] of Object.entries(PATH_META)) if (m.unit === 'x') {
      const x = getPath(DEFAULTS, p)
      const rng = mulberry32(1)
      let s = 0
      for (let d = 0; d < 20000; d++) s += pert(rng, m.defaultRange(x)) / 20000
      expect(Math.abs(s / x - 1)).toBeLessThan(0.05)
    }
  })
})

describe('confirmed book ranges are locked; levers are never drawn', () => {
  test('a confirmed exit-notice entry makes every future use the likely notice', () => {
    const i = book((x) => { x.book.contractMix = { fixed: 0, evergreen: 1, tfc: 0 }; x.book.healthMix = { green: 0, amber: 0, red: 1 }; x.book.priors.red = { transfer: 0, exit: 1, replatform: 0 }; x.book.exitNotice.evergreen = [2, 5, 20]; x.book.waves = [{ weeksAfterFreeze: 30, pct: 1 }] })
    i.assumptions['book.exitNotice'] = { status: 'confirmed' }
    const x = structuredClone(i)
    lockConfirmedBookRanges(x)
    expect(x.book.exitNotice.evergreen).toEqual([5, 5, 5])
    for (let d = 0; d < 20; d++) {
      const s = sampledBook(x, 16, mulberry32(d))
      expect(s.exitLeaving[21]).toBeCloseTo(1, 9) // every client exits at freeze end + 5
    }
    // estimated: drawn from the range
    const y = structuredClone(i); y.assumptions['book.exitNotice'] = { status: 'estimated' }
    lockConfirmedBookRanges(y)
    expect(y.book.exitNotice.evergreen).toEqual([2, 5, 20])
  })
  test('the retention effect stays a point even when someone types a range', () => {
    const i = clone(); i.people.split = true
    recordAnswer(i, 'people.retentionEffect', { low: 0.1, likely: 0.3, high: 0.5, status: 'estimated' })
    expect(i.assumptions['people.retentionEffect'].range).toEqual([0.3, 0.3, 0.3])
    expect(drawn(i).some(([p]) => p === 'people.retentionEffect')).toBe(false)
  })
})

describe('nits: markers with slip, backlog with exits, half-integer weeks, inert changes, CSV', () => {
  test('waveWeeks markers include the likely slip', () => {
    const r = run(book((x) => { x.book.waveSlip = [0, 3, 8] }))
    expect(r.waveWeeks).toEqual([16 + 6 + 3, 16 + 12 + 3, 16 + 18 + 3])
  })
  test('an all-exit book takes its email backlog with it', () => {
    const i = book((x) => { for (const h of ['green', 'amber', 'red'] as const) x.book.priors[h] = { transfer: 0, exit: 1, replatform: 0 }; x.pool.fte = 200 })
    const r = run(i)
    expect(r.emailBacklogMovedHours).toBeGreaterThan(0)
    const last = r.weeks[r.weeks.length - 1]
    expect(last.email.backlogHours).toBeLessThan(1e-6)
  })
  test('week ranges are whole weeks: a half-integer point lands on one week in both the closed form and the sampler', () => {
    const s = sanitiseBook({ ...book().book, replatformOffset: [6.5, 6.5, 6.5] }, book().book)
    expect(s.replatformOffset).toEqual([7, 7, 7])
    expect(pertQuantile(0.5, s.replatformOffset)).toBe(7)
  })
  test('run_scenario says when a change has no effect in the current mode', async () => {
    const t = new AgentTools({ getInputs: () => clone(), applyInputs: () => undefined, monteCarlo: async (i, d) => simulate(i, d, 1) })
    const out = JSON.parse(await t.execute('run_scenario', { label: 'x', changes: [{ path: 'book.healthMix.red', value: 0.4 }], waves: [], step_downs: [], balance: [] }))
    expect(out.warnings.some((w: string) => /No effect in this mode/.test(w))).toBe(true)
    const on = JSON.parse(await t.execute('run_scenario', { label: 'y', changes: [{ path: 'book.useBook', value: 1 }, { path: 'book.healthMix.red', value: 0.4 }], waves: [], step_downs: [], balance: [] }))
    expect(on.warnings.some((w: string) => /No effect/.test(w))).toBe(false)
  })
  test('CSV carries book_remaining in book mode and nothing extra in manual mode', () => {
    const r = run(book())
    const csv = toCsv(r)
    expect(csv.split('\n')[0]).toContain('book_remaining')
    expect(csv.split('\n')[1].split(',').pop()).toBe(r.book!.remaining[0].toFixed(4))
    expect(csv.split('\n')[20].split(',').pop()).toBe(r.book!.remaining[19].toFixed(4))
    expect(toCsv(run(clone())).split('\n')[0]).not.toContain('book_remaining')
  })
})

describe('independent brute-force check of the closed form', () => {
  /** A sampler written from the stated rules only (no shared code with book.ts beyond the PERT draw). */
  function brute(i: Inputs, fe: number, n: number, seed: number): number[] {
    const b = i.book
    const W = i.horizonWeeks
    const rng = mulberry32(seed)
    const gone = new Array(W).fill(0)
    const contracts = ['fixed', 'evergreen', 'tfc'] as const
    const healths = ['green', 'amber', 'red'] as const
    const waves = [...b.waves].sort((x, y) => x.weeksAfterFreeze - y.weeksAfterFreeze)
    const wsum = waves.reduce((s, w) => s + w.pct, 0)
    const shares = waves.map((w, j) => (wsum > 1 ? w.pct / wsum : j === waves.length - 1 ? w.pct + 1 - wsum : w.pct))
    for (let k = 0; k < n; k++) {
      let u = rng(); let ci = 0; let acc = 0
      outer: for (const c of contracts) for (const h of healths) { acc += b.contractMix[c] * b.healthMix[h]; if (u < acc) break outer; ci++ }
      const c = contracts[Math.floor(ci / 3)], h = healths[ci % 3]
      const pr = b.priors[h]
      const uf = rng()
      const fate = uf < pr.transfer ? 'transfer' : uf < pr.transfer + pr.exit ? 'exit' : 'replatform'
      const slip = Math.round(pert(rng, b.waveSlip))
      let wave = Infinity
      if (waves.length) { const uw = rng(); let s = 0; for (let j = 0; j < waves.length; j++) { s += shares[j]; if (uw < s) { wave = fe + waves[j].weeksAfterFreeze + slip; break } } if (wave === Infinity) wave = fe + waves[waves.length - 1].weeksAfterFreeze + slip }
      let dep: number
      if (fate === 'transfer') dep = wave
      else if (fate === 'exit') {
        const e = c === 'fixed' ? b.fixedExpiry[0] + Math.floor(rng() * (b.fixedExpiry[1] - b.fixedExpiry[0] + 1)) : fe + Math.round(pert(rng, b.exitNotice[c]))
        dep = e >= wave ? wave : e
      } else dep = Math.min(wave, fe + Math.round(pert(rng, b.replatformOffset)))
      if (dep < W) gone[dep] += 1 / n
    }
    const rem: number[] = []
    let left = 1
    for (let w = 0; w < W; w++) { left -= gone[w]; rem.push(left) }
    return rem
  }
  test('demo, a narrow expiry window and a beyond-horizon freeze end agree within sampling error', () => {
    const cases: [Inputs, number][] = [
      [book(), 16],
      [book((x) => { x.book.fixedExpiry = [10, 12]; x.book.contractMix = { fixed: 0.6, evergreen: 0.2, tfc: 0.2 } }), 16],
      [book(), 50],
      [book((x) => { x.book.waves = [{ weeksAfterFreeze: 3, pct: 0.6 }]; x.book.waveSlip = [0, 2, 6] }), 12],
    ]
    for (const [i, fe] of cases) {
      const e = expectedBook(i, fe).remaining
      const n = 200_000
      const r = brute(i, fe, n, 3)
      for (let w = 0; w < e.length; w++) {
        const se = Math.sqrt(Math.max(e[w] * (1 - e[w]), 1e-6) / n)
        expect(Math.abs(e[w] - r[w])).toBeLessThan(4 * se + 1e-3)
      }
    }
  }, 60_000)
})
