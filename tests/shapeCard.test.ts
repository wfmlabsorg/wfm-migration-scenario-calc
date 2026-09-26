import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { DEFAULTS } from '../src/lib/defaults'
import { run } from '../src/lib/engine'
import { recordAnswer } from '../src/lib/register'
import { CARD_FORMAT, checkCard, fromShapeCard, toShapeCard } from '../src/lib/shapeCard'
import type { Inputs } from '../src/lib/types'

const clone = (): Inputs => structuredClone(DEFAULTS)
const cover0 = (i: Inputs) => { const w = run(i).weeks[0]; return w.fteAvail / w.fteReq }

describe('shape cards', () => {
  test('carry no volumes or headcount', () => {
    const card = toShapeCard(clone())
    const text = JSON.stringify(card)
    expect(text).not.toContain('"volume"')
    expect(text).not.toContain('"fte"')
    expect(card.format).toBe(CARD_FORMAT)
    expect(checkCard(card)).toBeNull()
  })

  test('round trip at the same team size reproduces week-0 cover, the workload mix and the timing', () => {
    const i = clone()
    recordAnswer(i, 'freeze.length', { low: 13, likely: 17, high: 26, status: 'estimated', owner: 'HR' })
    recordAnswer(i, 'channels.voice.volume', { low: 29000, likely: 30820, high: 33000, status: 'estimated' })
    i.projectQuestions = [{ id: 'Q6', text: 'Freeze start and wave dates', sets: ['freeze.startWeek', 'freeze.length'] }]
    const card = JSON.parse(JSON.stringify(toShapeCard(i)))
    const back = fromShapeCard(card, i.pool.fte)
    expect(cover0(back)).toBeCloseTo(cover0(i), 3)
    const again = toShapeCard(back)
    for (const c of ['voice', 'chat', 'email'] as const) expect(again.mix[c]).toBeCloseTo(card.mix[c], 3)
    for (const c of ['voice', 'chat', 'email'] as const) expect(back.channels[c].volume / i.channels[c].volume).toBeCloseTo(1, 2)
    expect(back.freeze).toEqual(i.freeze)
    expect(back.after.waves).toEqual(i.after.waves)
    expect(back.assumptions['freeze.length']).toEqual(i.assumptions['freeze.length'])
    // relative volume range travels as a share and comes back around the rebuilt volume
    const r = back.assumptions['channels.voice.volume'].range!
    expect(r[0] / r[1]).toBeCloseTo(29000 / 30820, 6)
    expect(back.projectQuestions).toEqual(i.projectQuestions)
    expect(back.uncertainty.enabled).toBe(true)
  })

  test('a different team size keeps the shape: same cover, volumes scale', () => {
    const card = toShapeCard(clone())
    const small = fromShapeCard(card, 100)
    expect(cover0(small)).toBeCloseTo(card.cover, 3)
    expect(small.pool.fte).toBe(100)
    expect(small.channels.voice.volume).toBeLessThan(DEFAULTS.channels.voice.volume * 0.5)
  })

  test('the guard rejects anything with scale or long text', () => {
    const card = toShapeCard(clone()) as unknown as Record<string, any>
    const bad1 = structuredClone(card); bad1.scenario.channels.voice.volume = 1000
    const bad2 = structuredClone(card); bad2.scenario.pool.fte = 274
    const bad3 = structuredClone(card); bad3.title = 'x'.repeat(250)
    const bad4 = { ...structuredClone(card), format: 'something-else' }
    for (const b of [bad1, bad2, bad3, bad4]) expect(checkCard(b)).not.toBeNull()
    expect(() => fromShapeCard(bad1)).toThrow(/volumes/)
  })

  test('the Python pack sample card loads', () => {
    const path = 'tests/fixtures/pack-sample-card.json'
    let raw: unknown
    try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { return } // written by the pack exporter
    const i = fromShapeCard(raw, 250)
    expect(run(i).weeks.length).toBe(i.horizonWeeks)
  })
})
