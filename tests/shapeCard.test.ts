import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { DEFAULTS } from '../src/lib/defaults'
import { run } from '../src/lib/engine'
import { recordAnswer } from '../src/lib/register'
import { CARD_FORMAT, cardWarnings, checkCard, fromShapeCard, toShapeCard } from '../src/lib/shapeCard'
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

  test('the Python pack sample card loads and its departure curve matches the pack', () => {
    const raw = JSON.parse(readFileSync('tests/fixtures/pack-sample-card.json', 'utf8')) // written by pack/src/export_shape_card.py (demo config)
    const curve = JSON.parse(readFileSync('tests/fixtures/pack-sample-curve.json', 'utf8')) as { weeks: number; freezeEndMedian: number; expectedShareAtSourceFreezeFixed: number[] }
    expect(checkCard(raw)).toBeNull()
    const i = fromShapeCard(raw, 135)
    expect(i.freeze.endWeek).toBe(curve.freezeEndMedian)
    // occupancy reproduces: offered workload ÷ week-0 productive hours
    const c = i.channels
    const offered = (c.voice.volume * c.voice.aht + (c.chat.volume * c.chat.aht) / c.chat.concurrency + c.email.volume * c.email.aht) / 3600
    expect(offered / (135 * i.pool.paidHours * (1 - i.pool.shrinkage))).toBeCloseTo(raw.occupancy, 2)
    // the demand pass reproduces the pack's expected departure curve (freeze held at its median):
    // under Erlang C no retries are added, so weekly volume ÷ week-0 volume is the demand factor
    const det = structuredClone(i)
    det.service.model = 'C'
    const r = run(det)
    expect(r.weeks.length).toBe(i.horizonWeeks)
    const v0 = r.weeks[0].voice.volume + r.weeks[0].email.volume
    let maxErr = 0
    r.weeks.forEach((w, k) => { maxErr = Math.max(maxErr, Math.abs((w.voice.volume + w.email.volume) / v0 - curve.expectedShareAtSourceFreezeFixed[k])) })
    expect(maxErr).toBeLessThan(0.05)
    expect((r.weeks[r.weeks.length - 1].voice.volume + r.weeks[r.weeks.length - 1].email.volume) / v0).toBeLessThan(0.01)
    // the register: the card's entries over a full not-asked register
    expect(i.assumptions['freeze.length'].range).toEqual(raw.assumptions['freeze.length'].range)
    expect(i.assumptions['pool.shrinkage'].status).toBe('default') // not in the card → still drawn as not asked
    expect(Object.keys(i.assumptions).length).toBeGreaterThan(Object.keys(raw.assumptions).length)
    expect(cardWarnings(raw)[0]).toMatch(/expected \(mean\) staircase/)
    expect(JSON.stringify(raw)).not.toMatch(/"volume"|"fte"|"headcount"/)
  })
})
