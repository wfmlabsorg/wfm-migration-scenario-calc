import { describe, expect, test } from 'bun:test'
import { DEFAULTS } from '../src/lib/defaults'
import { run, scheduledWaves } from '../src/lib/engine'
import { mulberry32 } from '../src/lib/random'
import type { Inputs, RunResult } from '../src/lib/types'

const clone = (): Inputs => structuredClone(DEFAULTS)

/** No freeze effects, no runoff, no waves, no surge: nothing should move. */
function neutral(): Inputs {
  const i = clone()
  i.attrition.annual = 0
  i.demand.runoffPctWeek = 0
  i.demand.stepDowns = []
  i.after.waves = []
  i.after.surgePts = 0
  i.after.trainingHours = 0
  return i
}

function flowsBalance(r: RunResult) {
  const f = r.flows
  expect(f.start + f.hired).toBeCloseTo(f.attritionPre + f.attritionFreeze + f.attritionPost + f.moved + f.released + f.end, 9)
}

describe('neutral case', () => {
  const r = run(neutral())
  test('service stays at the week-0 level', () => {
    for (const w of r.weeks) {
      expect(w.voice.sl).toBeCloseTo(r.weeks[0].voice.sl, 9)
      expect(w.chat.sl).toBeCloseTo(r.weeks[0].chat.sl, 9)
      expect(w.email.backlogHours).toBeCloseTo(0, 9)
      expect(w.heads).toBeCloseTo(DEFAULTS.pool.fte, 9)
    }
  })
  test('baseline is healthy and above target', () => {
    expect(r.weeks[0].meetsAll).toBe(true)
    expect(r.weeks[0].voice.sl).toBeGreaterThan(DEFAULTS.channels.voice.slTarget)
  })
})

describe('headcount flows add up exactly', () => {
  test('deterministic, backfill on and off, releases on', () => {
    for (const backfill of [true, false]) {
      const i = clone()
      i.freeze.backfillBefore = backfill
      i.after.releasesOn = true
      flowsBalance(run(i))
    }
  })
  test('50 Monte Carlo draws', () => {
    const rng = mulberry32(7)
    for (let d = 0; d < 50; d++) flowsBalance(run(clone(), { rng, freezeEndOverride: 8 + (d % 12) }))
  })
  test('waves summing to 100% move everyone and all the work', () => {
    const r = run(clone())
    const last = r.weeks[r.weeks.length - 1]
    expect(last.heads).toBeCloseTo(0, 9)
    expect(last.voice.volume + last.chat.volume + last.email.volume).toBeCloseTo(0, 9)
    expect(Number.isNaN(last.score)).toBe(true) // nothing left to grade
  })
})

describe('wave shares', () => {
  test('30/30/40 of the book become conditional shares ending at 100%', () => {
    const i = clone()
    i.after.waves = [{ weeksAfterFreeze: 4, pct: 0.3 }, { weeksAfterFreeze: 10, pct: 0.3 }, { weeksAfterFreeze: 16, pct: 0.4 }]
    const w = scheduledWaves(i, 14)
    expect(w.map((x) => x.pct)).toEqual([0.3, 0.3 / 0.7, 1])
  })
  test('shares beyond 100% are capped', () => {
    const i = clone()
    i.after.waves = [{ weeksAfterFreeze: 2, pct: 0.8 }, { weeksAfterFreeze: 4, pct: 0.8 }]
    expect(scheduledWaves(i, 10).map((x) => x.pct)).toEqual([0.8, 1])
  })
})

describe('channel priority', () => {
  const i = clone()
  i.pool.fte = 70 // badly short
  const r = run(i)
  test('chat gets nothing beyond need until voice meets target; email only after both', () => {
    for (const w of r.weeks) {
      if (!w.voice.scored) continue
      if (w.voice.sl < i.channels.voice.slTarget - 1e-6) expect(w.chat.given).toBeCloseTo(0, 6)
      if (w.chat.sl < i.channels.chat.slTarget - 1e-6) expect(w.email.workedHours).toBeCloseTo(0, 6)
    }
  })
})

describe('email conservation', () => {
  test('arrivals = worked + backlog left + backlog moved out', () => {
    const i = clone()
    i.pool.fte = 100
    const r = run(i)
    const arr = r.weeks.reduce((s, w) => s + w.email.arrivalHours, 0)
    const worked = r.weeks.reduce((s, w) => s + w.email.workedHours, 0)
    expect(arr).toBeCloseTo(worked + r.weeks[r.weeks.length - 1].email.backlogHours + r.emailBacklogMovedHours, 6)
  })
})

describe('borrowed capacity', () => {
  test('with penalty 1 and every channel eligible, equals the same in-house FTE (no shrink effects)', () => {
    const a = neutral()
    a.pool.fte = 90
    a.borrowed = { ...a.borrowed, fte: 10, startWeek: 0, endWeek: 99, ahtPenalty: 1 }
    const b = neutral()
    b.pool.fte = 100
    const ra = run(a)
    const rb = run(b)
    for (let w = 0; w < ra.weeks.length; w++) {
      expect(ra.weeks[w].voice.sl).toBeCloseTo(rb.weeks[w].voice.sl, 6)
      expect(ra.weeks[w].email.backlogHours).toBeCloseTo(rb.weeks[w].email.backlogHours, 6)
    }
  })
  test('never serves an ineligible channel', () => {
    const i = neutral()
    i.pool.fte = 60
    i.borrowed = { ...i.borrowed, fte: 40, startWeek: 0, endWeek: 99, ahtPenalty: 1, eligible: { voice: false, chat: false, email: true } }
    const withB = run(i)
    const j = structuredClone(i)
    j.borrowed.fte = 0
    const without = run(j)
    // voice and chat must be no better than without borrowed staff…
    for (let w = 0; w < withB.weeks.length; w++) expect(withB.weeks[w].voice.sl).toBeLessThanOrEqual(without.weeks[w].voice.sl + 1e-9)
    // …while email is helped
    expect(withB.weeks[10].email.backlogHours).toBeLessThan(without.weeks[10].email.backlogHours)
  })
})

describe('direction of effects', () => {
  test('more FTE never makes service worse', () => {
    let prev: RunResult | null = null
    for (const fte of [80, 100, 120, 140]) {
      const i = clone()
      i.pool.fte = fte
      const r = run(i)
      if (prev) for (let w = 0; w < r.weeks.length; w++) if (r.weeks[w].voice.scored) expect(r.weeks[w].voice.sl).toBeGreaterThanOrEqual(prev.weeks[w].voice.sl - 1e-9)
      prev = r
    }
  })
  test('a higher tension multiplier leaves fewer heads at freeze end', () => {
    const lo = clone()
    const hi = clone()
    hi.attrition.tensionMult = 3
    expect(run(hi).weeks[13].heads).toBeLessThan(run(lo).weeks[13].heads)
  })
  test('schedule fit that follows demand needs no more than a flat schedule', () => {
    const fit = neutral()
    fit.profile.scheduleFit = 1
    const flat = neutral()
    flat.profile.scheduleFit = 0
    expect(run(fit).weeks[0].fteReq).toBeLessThanOrEqual(run(flat).weeks[0].fteReq + 1e-9)
  })
  test('at the required FTE every channel meets target', () => {
    const i = neutral()
    const req = run(i).weeks[0].fteReq
    i.pool.fte = req / (1 - 0) // fteReq is already in heads
    const r = run(i)
    expect(r.weeks[0].meetsAll).toBe(true)
  })
})

describe('edge cases never leak NaN or throw', () => {
  const variants: [string, (i: Inputs) => void][] = [
    ['100% runoff', (i) => { i.demand.runoffPctWeek = 1 }],
    ['zero FTE', (i) => { i.pool.fte = 0 }],
    ['concurrency 1', (i) => { i.channels.chat.concurrency = 1 }],
    ['freeze length 0', (i) => { i.freeze.endWeek = i.freeze.startWeek }],
    ['freeze end before start', (i) => { i.freeze.endWeek = 0 }],
    ['waves beyond horizon', (i) => { i.after.waves = [{ weeksAfterFreeze: 60, pct: 1 }] }],
    ['no waves', (i) => { i.after.waves = [] }],
    ['zero chat volume', (i) => { i.channels.chat.volume = 0 }],
  ]
  for (const [name, f] of variants)
    test(name, () => {
      const i = clone()
      f(i)
      const r = run(i)
      for (const w of r.weeks) {
        expect(Number.isFinite(w.heads)).toBe(true)
        expect(Number.isFinite(w.fteAvail)).toBe(true)
        expect(Number.isFinite(w.fteReq)).toBe(true)
        expect(Number.isFinite(w.email.backlogHours)).toBe(true)
        if (w.voice.scored) expect(Number.isFinite(w.voice.sl)).toBe(true)
      }
    })
  test('concurrency 1 makes chat behave like voice with the same AHT and threshold', () => {
    const i = neutral()
    i.channels.chat = { volume: i.channels.voice.volume, aht: i.channels.voice.aht, slTarget: i.channels.voice.slTarget, slSeconds: i.channels.voice.slSeconds, concurrency: 1 }
    const w = run(i).weeks[0]
    expect(w.chat.need).toBeCloseTo(w.voice.need, 9)
  })
  test('waves beyond the horizon raise a warning', () => {
    const i = clone()
    i.after.waves = [{ weeksAfterFreeze: 60, pct: 1 }]
    expect(run(i).warnings.length).toBeGreaterThan(0)
  })
})

describe('performance', () => {
  test('a 78-week deterministic run is well under 50 ms', () => {
    const i = clone()
    i.horizonWeeks = 78
    run(i)
    const t0 = performance.now()
    run(i)
    expect(performance.now() - t0).toBeLessThan(50)
  })
})
