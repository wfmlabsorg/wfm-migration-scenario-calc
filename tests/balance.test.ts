import { beforeAll, describe, expect, test } from 'bun:test'
import { DEFAULTS } from './legacyDemo'
import { run } from '../src/lib/engine'
import { curve } from '../src/lib/erlang'
import { curveA } from '../src/lib/erlangA'
import { kpis } from '../src/lib/kpis'
import type { BalanceMode, Channel, Inputs } from '../src/lib/types'

const MODES: BalanceMode[] = ['priority', 'floor', 'prorata', 'equal']
const ORDERS: Channel[][] = [
  ['voice', 'chat', 'email'], ['voice', 'email', 'chat'], ['chat', 'voice', 'email'],
  ['chat', 'email', 'voice'], ['email', 'voice', 'chat'], ['email', 'chat', 'voice'],
]

let MODEL: 'A' | 'C' = 'C'
function scenario(mode: BalanceMode, extra: (i: Inputs) => void = () => {}): Inputs {
  const i = structuredClone(DEFAULTS)
  i.service.model = MODEL
  i.balance = { ...i.balance, mode }
  extra(i)
  return i
}
const short = (i: Inputs) => { i.pool.fte = 215 } // short from week 0
const borrowedMix = (i: Inputs) => { i.borrowed = { ...i.borrowed, fte: 30, startWeek: 0, endWeek: 38, ahtPenalty: 1.2, eligible: { voice: false, chat: true, email: false } } }

// every policy is checked under both service models
for (const model of ['C', 'A'] as const)
  describe(`Erlang ${model}`, () => {
    beforeAll(() => { MODEL = model })
  describe('every policy conserves capacity and stays finite', () => {
    for (const mode of MODES)
      for (const [name, f] of [['demo', () => {}], ['short', short], ['borrowedMix', borrowedMix]] as const)
        test(`${mode} / ${name}`, () => {
          const i = scenario(mode, f)
          for (const week of [0, 5, 14, 18, 22, 27, 32]) {
            const t = run(i, { traceWeek: week }).trace!
            const given = t.buckets.reduce((s, b) => s + (b.voice.agentsFinal + b.chat.agentsFinal) * b.openHours, 0)
            const supplied = t.hours.productive + t.borrowed.homeEquivalentHours
            const used = given + t.email.workedHours + t.borrowed.idleHours + t.balance.inHouseIdleHours
            expect(used).toBeCloseTo(supplied, 6)
            for (const b of t.buckets) for (const x of [b.voice.agentsFinal, b.chat.agentsFinal, b.voice.targetAgents, b.chat.targetAgents]) expect(x).toBeGreaterThanOrEqual(-1e-9)
            expect(t.email.workedHours).toBeGreaterThanOrEqual(0)
            expect(t.email.backlogOut).toBeGreaterThanOrEqual(-1e-9)
          }
          const r = run(i)
          const f2 = r.flows
          expect(f2.start + f2.hired).toBeCloseTo(f2.attritionPre + f2.attritionFreeze + f2.attritionPost + f2.moved + f2.released + f2.end, 9)
          const arr = r.weeks.reduce((s, w) => s + w.email.arrivalHours, 0)
          const wk = r.weeks.reduce((s, w) => s + w.email.workedHours, 0)
          expect(arr).toBeCloseTo(wk + r.weeks[r.weeks.length - 1].email.backlogHours + r.emailBacklogMovedHours, 6)
          for (const w of r.weeks) {
            expect(Number.isFinite(w.fteAvail) && Number.isFinite(w.fteReq)).toBe(true)
            if (w.voice.scored) expect(Number.isFinite(w.voice.sl)).toBe(true)
          }
        })
  })

  describe('floor', () => {
    test('a zero floor behaves like strict priority', () => {
      const a = run(scenario('priority', short))
      const b = run(scenario('floor', (i) => { short(i); i.balance.emailFloor = 0 }))
      for (let w = 0; w < a.weeks.length; w++) {
        expect(b.weeks[w].email.backlogHours).toBeCloseTo(a.weeks[w].email.backlogHours, 6)
        if (a.weeks[w].voice.scored) expect(b.weeks[w].voice.sl).toBeCloseTo(a.weeks[w].voice.sl, 9)
      }
    })
    test('email receives at least its floor (or all email-usable capacity)', () => {
      const i = scenario('floor', short)
      for (const week of [2, 10, 16, 20]) {
        const t = run(i, { traceWeek: week }).trace!
        const floor = Math.min(t.email.backlogIn + t.email.arrivalHours, i.balance.emailFloor * t.email.arrivalHours)
        expect(t.email.workedHours).toBeGreaterThanOrEqual(Math.min(floor, t.email.capacityHours) - 1e-6)
      }
    })
    test('protecting email shortens the backlog and costs voice/chat some service', () => {
      const p = kpis(scenario('priority'), run(scenario('priority')))
      const f = kpis(scenario('floor'), run(scenario('floor')))
      expect(f.worstEmailBacklogDays).toBeLessThan(p.worstEmailBacklogDays / 2)
      expect(f.weeksBelowTarget.voice + f.weeksBelowTarget.chat).toBeGreaterThan(p.weeksBelowTarget.voice + p.weeksBelowTarget.chat)
    })
  })

  describe('prorata', () => {
    test('when short, every channel gets the same fraction of its need before spare', () => {
      const i = scenario('prorata', short)
      let checked = 0
      for (let week = 0; week < 30; week++) {
        const t = run(i, { traceWeek: week }).trace!
        const r = t.balance.ratio!
        if (r >= 1 - 1e-9) continue
        checked++
        for (const b of t.buckets) {
          if (b.voice.needAgents > 0) expect(b.voice.agentsBeforeSpare / b.voice.needAgents).toBeCloseTo(r, 6)
          if (b.chat.needAgents > 0) expect(b.chat.agentsBeforeSpare / b.chat.needAgents).toBeCloseTo(r, 6)
        }
        expect(t.email.workedBeforeTopUp / Math.min(t.email.backlogIn + t.email.arrivalHours, t.email.need)).toBeCloseTo(r, 6)
      }
      expect(checked).toBeGreaterThan(5)
    })
  })

  describe('equal attainment', () => {
    test('when short, the targets give every channel the same attainment', () => {
      const i = scenario('equal', short)
      let checked = 0
      for (let week = 0; week < 30; week++) {
        const r = run(i, { traceWeek: week })
        const t = r.trace!
        const a = t.balance.attainment
        if (a === null || a >= 1 - 1e-9) continue
        checked++
        expect(a).toBeGreaterThan(0)
        // email: its target leaves exactly the backlog at which on-time = a
        const due = t.email.workedHours + t.email.backlogOut
        const emailOnTimeAtTarget = Math.min(1, t.email.targetDays / ((due - t.email.targetHours) / t.email.dailyArrivalHours))
        // voice and chat: per bucket, the target is the agents that give service = a × target
        for (const b of t.buckets) {
          const v = i.channels.voice
          const serviceable = MODEL === 'A' ? b.voice.targetAgents > 0 : b.voice.targetAgents > b.voice.offeredErlangs
          if (b.voice.offeredErlangs > 0 && serviceable) {
            const c = MODEL === 'A'
              ? curveA(b.voice.offeredErlangs, v.aht / i.service.patience.voice, v.slSeconds / v.aht)
              : curve(b.voice.offeredErlangs, v.slSeconds / v.aht)
            expect(c.sl(b.voice.targetAgents) / i.channels.voice.slTarget).toBeCloseTo(a, 4)
          }
        }
        if (t.email.targetHours > 0) expect(emailOnTimeAtTarget).toBeCloseTo(a, 3)
      }
      expect(checked).toBeGreaterThan(3)
    })
    test('with enough staff, attainment is 1 and every target is met', () => {
      const i = scenario('equal', (x) => { x.pool.fte = 400 })
      const r = run(i)
      for (const w of r.weeks.slice(0, 10)) expect(w.meetsAll).toBe(true)
      expect(run(i, { traceWeek: 3 }).trace!.balance.attainment).toBe(1)
    })
    test('spreads the damage: fewer email weeks below target than strict priority', () => {
      const p = kpis(scenario('priority'), run(scenario('priority')))
      const e = kpis(scenario('equal'), run(scenario('equal')))
      expect(e.weeksBelowTarget.email).toBeLessThan(p.weeksBelowTarget.email)
    })
  })

  describe('priority order', () => {
    for (const order of ORDERS)
      test(`the first channel in ${order.join(' → ')} gets its full need when capacity allows`, () => {
        const i = scenario('priority', (x) => { short(x); x.balance.order = order })
        const t = run(i, { traceWeek: 12 }).trace!
        const first = order[0]
        if (first === 'email') expect(t.email.workedBeforeTopUp).toBeCloseTo(Math.min(t.email.need, t.email.backlogIn + t.email.arrivalHours), 6)
        else for (const b of t.buckets) expect(b[first].agentsBeforeSpare).toBeCloseTo(b[first].needAgents, 9)
      })
    test('an invalid order falls back to voice → chat → email', () => {
      const a = run(scenario('priority', (x) => { x.balance.order = ['voice', 'voice', 'email'] }))
      const b = run(scenario('priority'))
      expect(a.weeks[20].email.backlogHours).toBe(b.weeks[20].email.backlogHours)
    })
  })

  describe('borrowed eligibility holds in every mode', () => {
    for (const mode of MODES)
      test(mode, () => {
        const i = scenario(mode, (x) => { x.pool.fte = 150; x.borrowed = { ...x.borrowed, fte: 60, startWeek: 0, endWeek: 38, ahtPenalty: 1, eligible: { voice: false, chat: false, email: true } } })
        const t = run(i, { traceWeek: 10 }).trace!
        expect(t.balance.borrowedHoursByChannel.voice).toBe(0)
        expect(t.balance.borrowedHoursByChannel.chat).toBe(0)
      })
  })

  describe('performance in every mode', () => {
    for (const mode of MODES)
      test(`${mode}: a 78-week run is under 50 ms`, () => {
        const i = scenario(mode, (x) => { x.horizonWeeks = 78; short(x) })
        run(i)
        const t0 = performance.now()
        run(i)
        expect(performance.now() - t0).toBeLessThan(50)
      })
  })
  })
