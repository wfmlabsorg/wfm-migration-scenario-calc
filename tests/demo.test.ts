// The current default scenario: a synthetic 100-FTE travel-counsellor team (phone + email).
import { describe, expect, test } from 'bun:test'
import { cloneDefaults, DEFAULTS } from '../src/lib/defaults'
import { run } from '../src/lib/engine'
import { kpis } from '../src/lib/kpis'
import { simulate } from '../src/lib/montecarlo'
import { fromShapeCard, toShapeCard } from '../src/lib/shapeCard'

describe('default demo: travel-counsellor team', () => {
  const r = run(DEFAULTS)
  const w0 = r.weeks[0]
  test('phone and email only, 10-minute handle times, equal attainment', () => {
    expect(DEFAULTS.channels.chat.volume).toBe(0)
    expect(DEFAULTS.channels.voice.aht).toBe(600)
    expect(DEFAULTS.channels.email.aht).toBe(600)
    expect(DEFAULTS.balance.mode).toBe('equal')
    expect(w0.chat.scored).toBe(false)
  })
  test('starts slightly short (cover 0.92–0.97) with phone at or near target', () => {
    const cover = w0.fteAvail / w0.fteReq
    expect(cover).toBeGreaterThan(0.92)
    expect(cover).toBeLessThan(0.97)
    expect(w0.voice.sl).toBeGreaterThan(0.7)
  })
  test('the migration produces a valley on both channels', () => {
    const k = kpis(DEFAULTS, r)
    expect(k.weeksBelowTarget.voice).toBeGreaterThan(5)
    expect(k.weeksBelowTarget.email).toBeGreaterThan(5)
    expect(k.peakAbandonment.voice.rate).toBeGreaterThan(DEFAULTS.service.abandonCap)
  })
  test('headcount identity and no NaN in scored weeks', () => {
    const f = r.flows
    expect(f.start + f.hired).toBeCloseTo(f.attritionPre + f.attritionFreeze + f.attritionPost + f.moved + f.released + f.end, 9)
    for (const w of r.weeks) if (w.voice.scored) expect(Number.isFinite(w.voice.sl)).toBe(true)
  })
  test('Monte Carlo runs and the shape card round-trips', () => {
    const b = simulate(DEFAULTS, 200, 1)
    expect(b.bandWidth).toBeGreaterThan(0)
    const back = fromShapeCard(JSON.parse(JSON.stringify(toShapeCard(cloneDefaults()))), 100)
    expect(back.channels.chat.volume).toBe(0)
    expect(back.channels.voice.volume / DEFAULTS.channels.voice.volume).toBeCloseTo(1, 1)
  })
})

describe('headline backlog counts scored weeks only', () => {
  test('a residual sliver after the book has gone does not set the worst backlog', () => {
    const i = cloneDefaults()
    const r = run(i)
    const k = kpis(i, r)
    const scored = r.weeks.filter((w) => w.email.scored).map((w) => w.email.backlogDays)
    expect(k.worstEmailBacklogDays).toBe(Math.max(0, ...scored))
  })
})
