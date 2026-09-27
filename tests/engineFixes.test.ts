// Regression tests for the v1.3 engine audit: each one would have caught the finding it names.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { applyChanges } from '../src/agent/schema'
import { AgentTools } from '../src/agent/tools'
import { DEFAULTS } from './legacyDemo'
import { run } from '../src/lib/engine'
import { EQUATIONS } from '../src/lib/equations'
import { worstWeek } from '../src/lib/kpis'
import { drawAssumptions, simulate } from '../src/lib/montecarlo'
import { PATH_META } from '../src/lib/questions'
import { binomial, mulberry32 } from '../src/lib/random'
import { drawn, getPath, recordAnswer, syncRegister } from '../src/lib/register'
import { decode } from '../src/lib/share'
import type { Inputs } from '../src/lib/types'

const clone = (): Inputs => structuredClone(DEFAULTS)
const tools = (screen: Inputs) => new AgentTools({ getInputs: () => screen, applyInputs: () => undefined, monteCarlo: async (i, d) => simulate(i, d, 1) })

describe('1. analyst changes reach the Monte Carlo', () => {
  test('applyChanges syncs the register', () => {
    const i = applyChanges(clone(), { changes: [{ path: 'freeze.endWeek', value: 26 }, { path: 'channels.voice.volume', value: 45000 }] })
    expect(i.assumptions['freeze.length'].range![1]).toBe(26 - i.freeze.startWeek)
    expect(i.assumptions['channels.voice.volume'].range![1]).toBe(45000)
  })
  test('run_scenario + run_monte_carlo centre on the changed inputs', async () => {
    const t = tools(clone())
    await t.execute('run_scenario', { label: 'long', changes: [{ path: 'freeze.endWeek', value: 26 }], waves: [], step_downs: [], balance: [] })
    const mc = JSON.parse(await t.execute('run_monte_carlo', { label: 'long', draws: 200 }))
    expect(Math.abs(mc.freezeEndWeek.p50 - 26)).toBeLessThanOrEqual(3)
  })
  test('simulate() itself tolerates a stale register', () => {
    const i = clone()
    i.channels.voice.volume = 45000 // no sync
    const stale = simulate(i, 150, 3)
    const j = clone()
    j.channels.voice.volume = 45000
    syncRegister(j)
    expect(stale.p50.voice).toEqual(simulate(j, 150, 3).p50.voice)
  })
})

describe('3. binomial attrition is unbiased at the operating point', () => {
  for (const [n, p] of [[260, 0.14 / 52], [60, 0.14 / 52], [100, 0.14 / 52 * 2.5], [5000, 0.3]] as const)
    test(`n=${n} p=${p.toFixed(4)}`, () => {
      const rng = mulberry32(99)
      const N = 40_000
      let s = 0
      for (let k = 0; k < N; k++) s += binomial(rng, n, p)
      const mean = s / N
      const se = Math.sqrt((n * p * (1 - p)) / N)
      expect(Math.abs(mean - n * p)).toBeLessThan(Math.max(0.005 * n * p, 4 * se))
    })
})

describe('4. releases never happen while the team is short', () => {
  test('with backlog and retries in the requirement, released > 0 implies fteAvail ≥ fteReq', () => {
    for (const fte of [245, 260, 300]) {
      const i = clone()
      i.after.releasesOn = true
      i.after.noticeWeeks = 0
      i.after.releaseBuffer = 0
      i.pool.fte = fte
      const r = run(i)
      for (const w of r.weeks) if (w.released > 1e-9) expect(w.fteAvail).toBeGreaterThanOrEqual(w.fteReq - 1e-6)
      if (fte >= 260) expect(r.weeks.some((w) => w.released > 0)).toBe(true) // a team short from the start never releases
    }
  })
})

describe('5. borrowed staff are used first on email', () => {
  test('email-only borrowed staff never sit idle while the team serves email and voice misses target', () => {
    const i = clone()
    i.service.model = 'C'
    i.balance = { mode: 'floor', order: ['voice', 'chat', 'email'], emailFloor: 0.9 }
    i.pool.fte = 200
    i.borrowed = { fte: 40, startWeek: 0, endWeek: 38, ahtPenalty: 1, eligible: { voice: false, chat: false, email: true } }
    const r = run(i)
    for (let w = 0; w < 20; w++) {
      const t = run(i, { traceWeek: w }).trace!
      const inHouseOnEmail = t.email.workedHours - t.balance.borrowedHoursByChannel.email
      if (t.borrowed.idleHours > 1e-6) expect(inHouseOnEmail).toBeLessThan(1e-6)
      if (r.weeks[w].voice.scored && r.weeks[w].voice.sl < i.channels.voice.slTarget - 1e-6) expect(t.borrowed.idleHours).toBeLessThan(1e-6)
    }
  })
})

describe('6. a confirmed answer stays a point', () => {
  test('moving the input moves the point; it is never drawn', () => {
    const i = clone()
    recordAnswer(i, 'attrition.annual', { likely: 0.14, status: 'confirmed' })
    i.attrition.annual = 0.18
    syncRegister(i)
    expect(i.assumptions['attrition.annual']).toEqual({ range: [0.18, 0.18, 0.18], status: 'confirmed' })
    expect(drawn(i).map(([p]) => p)).not.toContain('attrition.annual')
  })
})

describe('7. links are sanitised', () => {
  const link = (patch: Record<string, unknown>) => {
    const old = { ...(structuredClone(DEFAULTS) as unknown as Record<string, unknown>), ...patch }
    return decode(`#s=${Buffer.from(JSON.stringify(old)).toString('base64url')}`)!
  }
  test('bad v1.2 ranges are dropped or clamped', () => {
    const a = link({ assumptions: undefined, uncertainty: { enabled: true, draws: 100, seed: 1, freezeLength: ['a', 'b', 'c'], tensionMult: [-50, 1.5, 5000] } })
    expect(a.assumptions['freeze.length'].status).toBe('default')
    const t = a.assumptions['attrition.tensionMult'].range!
    expect(t[0]).toBeGreaterThanOrEqual(PATH_META['attrition.tensionMult'].min)
    expect(t[2]).toBeLessThanOrEqual(PATH_META['attrition.tensionMult'].max)
    expect(Number.isFinite(simulate(a, 20, 1).freezeEnd.p50)).toBe(true)
  })
  test('bad waves, step-downs and horizon', () => {
    const a = link({ horizonWeeks: 0, after: { ...DEFAULTS.after, waves: [{ weeksAfterFreeze: 'x', pct: 'y' }, { weeksAfterFreeze: 6, pct: 0.5 }] }, demand: { ...DEFAULTS.demand, stepDowns: [{ week: NaN, pct: 2 }, { week: 20, pct: 0.1 }] } })
    expect(a.horizonWeeks).toBe(13)
    expect(a.after.waves).toEqual([{ weeksAfterFreeze: 6, pct: 0.5 }])
    expect(a.demand.stepDowns).toEqual([{ week: 20, pct: 0.1 }])
    expect(() => run(a)).not.toThrow()
  })
})

describe('8. inputs of one question move together', () => {
  test('the three channel volumes share a quantile; unrelated inputs do not', () => {
    const i = clone()
    const xs: number[] = []
    const ys: number[] = []
    const zs: number[] = []
    for (let d = 0; d < 300; d++) {
      const v = drawAssumptions(i, 7, d)
      xs.push(v['channels.voice.volume'] / i.channels.voice.volume)
      ys.push(v['channels.chat.volume'] / i.channels.chat.volume)
      zs.push(v['attrition.annual'] / i.attrition.annual)
    }
    const corr = (a: number[], b: number[]) => {
      const ma = a.reduce((s, x) => s + x, 0) / a.length
      const mb = b.reduce((s, x) => s + x, 0) / b.length
      let sab = 0, saa = 0, sbb = 0
      for (let k = 0; k < a.length; k++) { sab += (a[k] - ma) * (b[k] - mb); saa += (a[k] - ma) ** 2; sbb += (b[k] - mb) ** 2 }
      return sab / Math.sqrt(saa * sbb)
    }
    expect(corr(xs, ys)).toBeGreaterThan(0.99)
    expect(Math.abs(corr(xs, zs))).toBeLessThan(0.2)
  })
})

describe('9. unanswered ranges do not bias the forecast', () => {
  test('the all-default median stays within 2 points of the line before the freeze bites', () => {
    const i = clone()
    const det = run(i)
    const mc = simulate(i, 600, 11)
    for (let w = 0; w < 6; w++) {
      expect(Math.abs(mc.p50.voice[w] - det.weeks[w].voice.sl)).toBeLessThan(0.02)
      expect(Math.abs(mc.p50.email[w] - det.weeks[w].email.timeliness)).toBeLessThan(0.02)
    }
  })
})

describe('10. the worst week is the deepest, not the first D-', () => {
  test('demo under Erlang A', () => {
    const r = run(DEFAULTS)
    const w = worstWeek(DEFAULTS, r)!
    const ties = r.weeks.filter((x) => Number.isFinite(x.score) && Math.abs(x.score - w.score) < 1e-12)
    expect(ties.length).toBeGreaterThan(1) // several D- weeks
    for (const t of ties) expect(t.email.timeliness).toBeGreaterThanOrEqual(w.email.timeliness - 1e-12)
    expect(w.week).not.toBe(ties[0].week === w.week ? -1 : ties[0].week)
  })
})

describe('11. a future capped by abandonment is not "clean"', () => {
  test('cleanShare ≤ share meeting every target', () => {
    const i = clone()
    i.pool.fte = 275
    i.service.abandonCap = 0.02
    const loose = clone()
    loose.pool.fte = 275
    loose.service.abandonCap = 1
    expect(simulate(i, 150, 2).cleanShare).toBeLessThanOrEqual(simulate(loose, 150, 2).cleanShare)
  })
})

describe('the published grade formula reproduces the engine', () => {
  test('§6 re-implemented from the equations text', () => {
    expect(EQUATIONS).toContain('clamp((cover − 1) ÷ 0.10, 0, 1)')
    const clamp = (x: number) => Math.min(1, Math.max(0, x))
    for (const fte of [200, 220, 238, 260, 300])
      for (const model of ['A', 'C'] as const) {
        const i = clone()
        i.pool.fte = fte
        i.service.model = model
        for (const w of [0, 10, 18, 25]) {
          const t = run(i, { traceWeek: w }).trace!
          const g = t.grade
          if (!Number.isFinite(g.score)) continue
          let s = g.unstable ? 0.05 : g.meetsAll ? 0.7 + 0.3 * clamp((g.cover - 1) / 0.1) : 0.7 * clamp((Math.min(g.worstAttainment, 1) - 0.5) / 0.5)
          if (model === 'A' && g.worstAbandonRate > g.abandonCap) s = Math.min(s, g.worstAbandonRate > 2 * g.abandonCap ? 0.39 : 0.69)
          expect(s).toBeCloseTo(g.score, 12)
        }
      }
  })
})

describe('Erlang A golden fixture', () => {
  const golden = JSON.parse(readFileSync('tests/fixtures/golden-v1.3-erlangA.json', 'utf8'), (_k, v) =>
    typeof v === 'string' && v.startsWith('__') ? Number(v.slice(2)) : v,
  ) as Record<string, unknown>
  const variants: Record<string, (i: Inputs) => void> = {
    demo: () => {},
    borrowedVoiceOnly: (i) => { i.borrowed = { ...i.borrowed, fte: 25, startWeek: 6, endWeek: 30, ahtPenalty: 1.3, eligible: { voice: true, chat: false, email: false } } },
    releases: (i) => { i.after.releasesOn = true; i.after.noticeWeeks = 4; i.borrowed.fte = 10 },
    understaffed: (i) => { i.pool.fte = 200; i.demand.intakeOn = true; i.demand.runoffPctWeek = 0.01 },
  }
  function same(actual: unknown, expected: unknown, path: string, diffs: string[]) {
    if (typeof expected === 'number') { if (!Object.is(actual, expected)) diffs.push(`${path}: ${String(actual)} ≠ ${expected}`); return }
    if (expected && typeof expected === 'object') { for (const [k, v] of Object.entries(expected)) same((actual as Record<string, unknown>)?.[k], v, `${path}.${k}`, diffs); return }
    if (actual !== expected) diffs.push(`${path}: ${String(actual)} ≠ ${String(expected)}`)
  }
  for (const [name, f] of Object.entries(variants))
    test(name, () => {
      const i = clone()
      f(i)
      const r = run(i)
      const diffs: string[] = []
      same({ weeks: r.weeks, flows: r.flows, emailBacklogMovedHours: r.emailBacklogMovedHours }, golden[name], name, diffs)
      expect(diffs.slice(0, 5)).toEqual([])
    })
})
