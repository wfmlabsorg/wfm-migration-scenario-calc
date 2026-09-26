import { describe, expect, test } from 'bun:test'
import { AgentTools } from '../src/agent/tools'
import { DEFAULTS } from '../src/lib/defaults'
import { run } from '../src/lib/engine'
import { hash32, simulate } from '../src/lib/montecarlo'
import { PATH_META, QUESTIONS } from '../src/lib/questions'
import { drawn, getPath, recordAnswer, sanitiseRegister, setPath, syncRegister } from '../src/lib/register'
import { decode, encode } from '../src/lib/share'
import type { Inputs } from '../src/lib/types'

const clone = (): Inputs => structuredClone(DEFAULTS)

describe('register basics', () => {
  test('every question path is known, and every ranged path reads a number from the demo', () => {
    for (const q of QUESTIONS) for (const p of q.sets) expect(p in DEFAULTS.assumptions).toBe(true)
    for (const p of Object.keys(PATH_META)) expect(Number.isFinite(getPath(DEFAULTS, p))).toBe(true)
  })
  test('the demo starts with every question unanswered and likely = the input', () => {
    for (const [p, a] of Object.entries(DEFAULTS.assumptions)) {
      expect(a.status).toBe('default')
      if (a.range) {
        expect(a.range[1]).toBeCloseTo(getPath(DEFAULTS, p), 9)
        expect(a.range[0]).toBeLessThanOrEqual(a.range[1])
        expect(a.range[2]).toBeGreaterThanOrEqual(a.range[1])
      }
    }
  })
  test('freeze.length is end − start and writes the end week', () => {
    const i = clone()
    setPath(i, 'freeze.length', 20)
    expect(i.freeze.endWeek).toBe(i.freeze.startWeek + 20)
  })
  test('recording answers: estimated keeps the given range, confirmed collapses it', () => {
    const i = clone()
    recordAnswer(i, 'freeze.length', { low: 13, likely: 17, high: 26, status: 'estimated', owner: 'HR' })
    expect(i.freeze.endWeek - i.freeze.startWeek).toBe(17)
    expect(i.assumptions['freeze.length']).toEqual({ range: [13, 17, 26], status: 'estimated', owner: 'HR' })
    recordAnswer(i, 'attrition.annual', { likely: 0.18, status: 'confirmed' })
    expect(i.attrition.annual).toBe(0.18)
    expect(i.assumptions['attrition.annual'].range).toEqual([0.18, 0.18, 0.18])
  })
  test('moving a slider re-centres a default range and widens an answered one', () => {
    const i = clone()
    recordAnswer(i, 'channels.voice.aht', { low: 340, likely: 360, high: 380, status: 'estimated' })
    i.channels.voice.aht = 400
    i.attrition.tensionMult = 2
    syncRegister(i)
    expect(i.assumptions['channels.voice.aht'].range).toEqual([340, 400, 400])
    expect(i.assumptions['attrition.tensionMult'].range![1]).toBe(2)
    expect(i.assumptions['attrition.tensionMult'].status).toBe('default')
  })
  test('sanitise drops unknown paths, bad statuses and long strings', () => {
    const r = sanitiseRegister({ 'freeze.length': { range: [1, 2, 3], status: 'estimated', owner: 'x'.repeat(300) }, 'pool.nope': { status: 'default' }, 'attrition.annual': { status: 'maybe' } })
    expect(Object.keys(r)).toEqual(['freeze.length'])
    expect(r['freeze.length'].owner).toBeUndefined()
  })
})

describe('the register does not change the deterministic run', () => {
  test('answering with the current values leaves every weekly result identical', () => {
    const a = run(DEFAULTS)
    const i = clone()
    for (const p of Object.keys(PATH_META)) recordAnswer(i, p, { likely: getPath(i, p), status: 'confirmed' })
    const b = run(i)
    expect(b.weeks.map((w) => w.score)).toEqual(a.weeks.map((w) => w.score))
    expect(b.weeks.map((w) => w.voice.sl)).toEqual(a.weeks.map((w) => w.voice.sl))
  })
})

describe('bands narrow as answers arrive', () => {
  const width = (i: Inputs) => simulate(i, 400, 5).bandWidth
  test('all default > half confirmed > all confirmed', () => {
    const i = clone()
    const w0 = width(i)
    const paths = drawn(i).map(([p]) => p)
    for (const p of paths.slice(0, Math.ceil(paths.length / 2))) recordAnswer(i, p, { likely: getPath(i, p), status: 'confirmed' })
    const w1 = width(i)
    for (const p of paths) recordAnswer(i, p, { likely: getPath(i, p), status: 'confirmed' })
    const w2 = width(i)
    expect(w1).toBeLessThan(w0)
    expect(w2).toBeLessThan(w1)
    expect(w2).toBeGreaterThan(0) // binomial attrition remains
  }, 30_000)
  test("changing one input's range leaves the other inputs' draws unchanged (per-input streams)", () => {
    expect(hash32('a')).not.toBe(hash32('b'))
    const i = clone()
    for (const p of Object.keys(PATH_META)) if (p !== 'attrition.annual' && p !== 'freeze.length') recordAnswer(i, p, { likely: getPath(i, p), status: 'confirmed' })
    const a = simulate(i, 60, 9)
    const j = structuredClone(i)
    recordAnswer(j, 'attrition.annual', { low: 0.05, likely: 0.14, high: 0.4, status: 'estimated' })
    const b = simulate(j, 60, 9)
    // freeze length is drawn from its own stream, so the freeze-end distribution is identical
    expect(b.freezeEnd).toEqual(a.freezeEnd)
  })
  test('1,000 all-default draws under Erlang A in a few seconds', () => {
    const t0 = performance.now()
    simulate(clone(), 1000, 1)
    expect(performance.now() - t0).toBeLessThan(8000)
  }, 20_000)
})

describe('links', () => {
  test('v1.2 links become estimated entries for their five ranges; deterministic run unchanged', () => {
    const old = structuredClone(DEFAULTS) as unknown as Record<string, unknown>
    delete old.assumptions
    delete old.projectQuestions
    old.uncertainty = { enabled: true, draws: 500, seed: 1, freezeLength: [10, 14, 26], tensionMult: [1, 1.5, 2.5], postMult: [1.5, 2.5, 4], surgePts: [0, 0.04, 0.1], runoffPctWeek: [0, 0, 0.01] }
    const hash = Buffer.from(JSON.stringify(old)).toString('base64url')
    const i = decode(`#s=${hash}`)!
    // the five migrated ranges are estimated; every other question starts unasked with its generic range
    expect(Object.entries(i.assumptions).filter(([, a]) => a.status === 'estimated').map(([p]) => p).sort()).toEqual(['after.surgePts', 'attrition.postMult', 'attrition.tensionMult', 'demand.runoffPctWeek', 'freeze.length'])
    expect(Object.keys(i.assumptions).length).toBe(Object.keys(DEFAULTS.assumptions).length)
    expect(i.assumptions['channels.voice.aht'].status).toBe('default')
    expect(i.assumptions['freeze.length']).toEqual({ range: [10, 14, 26], status: 'estimated' })
    expect(run(i).weeks.map((w) => w.score)).toEqual(run({ ...DEFAULTS, service: i.service }).weeks.map((w) => w.score))
  })
  test('v1.3 links keep the register and project questions', () => {
    const i = clone()
    recordAnswer(i, 'freeze.length', { low: 13, likely: 17, high: 26, status: 'estimated' })
    i.projectQuestions = [{ id: 'Q6', text: 'Freeze start and wave dates', sets: ['freeze.startWeek', 'freeze.length', 'after.waves'] }]
    const back = decode(`#s=${encode(i)}`)!
    expect(back.assumptions['freeze.length']).toEqual(i.assumptions['freeze.length'])
    expect(back.projectQuestions).toEqual(i.projectQuestions)
  })
})

describe('analyst records answers', () => {
  test('record_assumption applies to the screen, and two answers in one turn both stick', async () => {
    const screen = clone()
    const applied: string[] = []
    const t = new AgentTools({ getInputs: () => screen, applyInputs: (_next, label) => { applied.push(label) } /* the page re-renders later */, monteCarlo: async (i, d) => simulate(i, d, 1) })
    await t.execute('record_assumption', { path: 'freeze.length', low: 13, likely: 17, high: 26, status: 'estimated', owner: 'HR', note: '' })
    const out = JSON.parse(await t.execute('record_assumption', { path: 'attrition.annual', low: 0.14, likely: 0.14, high: 0.14, status: 'confirmed', owner: '', note: '' }))
    expect(applied).toEqual(['answer: freeze.length', 'answer: attrition.annual'])
    expect(out.register.estimated).toBe(1)
    expect(out.register.confirmed).toBe(1)
    await expect(t.execute('record_assumption', { path: 'attrition.annual', low: 0.2, likely: 0.1, high: 0.3, status: 'estimated', owner: '', note: '' })).rejects.toThrow()
  })
})
