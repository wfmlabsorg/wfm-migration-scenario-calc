import { describe, expect, test } from 'bun:test'
import { applyChanges } from '../src/agent/schema'
import { cloneDefaults, DEFAULTS as CURRENT } from '../src/lib/defaults'
import { run, seasonalPts } from '../src/lib/engine'
import { decode, encode } from '../src/lib/share'
import { fromShapeCard, toShapeCard } from '../src/lib/shapeCard'
import { DEFAULTS as LEGACY } from './legacyDemo'

describe('seasonal shrinkage spikes', () => {
  test('the demo has a summer spike that lowers available FTE only in those weeks', () => {
    const on = run(CURRENT)
    const off = run({ ...cloneDefaults(), seasonality: { spikes: [] } })
    const sp = CURRENT.seasonality.spikes[0]
    for (const w of on.weeks) {
      const inSpike = w.week >= sp.startWeek && w.week < sp.startWeek + sp.weeks
      expect(w.seasonalPts).toBe(inSpike ? sp.pts : 0)
      if (w.week < sp.startWeek) expect(w.fteAvail).toBe(off.weeks[w.week].fteAvail)
      if (inSpike) expect(w.fteAvail).toBeLessThan(off.weeks[w.week].fteAvail)
      // required FTE is sized at base shrinkage: the spike never inflates it
      if (w.week < sp.startWeek) expect(w.fteReq).toBe(off.weeks[w.week].fteReq)
    }
  })
  test('overlapping spikes add; shrinkage is capped at 95%', () => {
    const i = cloneDefaults()
    i.seasonality.spikes = [{ startWeek: 5, weeks: 3, pts: 0.2 }, { startWeek: 6, weeks: 1, pts: 0.3 }]
    expect(seasonalPts(i, 6)).toBeCloseTo(0.5, 12)
    i.pool.shrinkage = 0.6
    const r = run(i)
    expect(Number.isFinite(r.weeks[6].fteAvail) && r.weeks[6].fteAvail >= 0).toBe(true)
  })
  test('old links and cards without seasonality get none, not the demo spike', () => {
    const old = structuredClone(LEGACY) as unknown as Record<string, unknown>
    delete old.seasonality
    expect(decode(`#s=${Buffer.from(JSON.stringify(old)).toString('base64url')}`)!.seasonality.spikes).toEqual([])
    const card = toShapeCard(structuredClone(LEGACY)) as unknown as { scenario: Record<string, unknown> }
    delete card.scenario.seasonality
    expect(fromShapeCard(card, 250).seasonality.spikes).toEqual([])
  })
  test('links and cards carry spikes; bad spikes are dropped', () => {
    const i = cloneDefaults()
    expect(decode(`#s=${encode(i)}`)!.seasonality).toEqual(i.seasonality)
    expect(fromShapeCard(JSON.parse(JSON.stringify(toShapeCard(i))), 100).seasonality).toEqual(i.seasonality)
    const bad = { ...i, seasonality: { spikes: [{ startWeek: -1, weeks: 3, pts: 0.2 }, { startWeek: 4, weeks: 2, pts: 0.9 }, { startWeek: 4, weeks: 2, pts: 0.1, label: 'x'.repeat(99) }] } }
    const back = decode(`#s=${encode(bad as never)}`)!
    expect(back.seasonality.spikes).toEqual([{ startWeek: 4, weeks: 2, pts: 0.1, label: 'x'.repeat(40) }])
  })
  test('the analyst can replace or remove spikes', () => {
    const a = applyChanges(cloneDefaults(), { shrinkSpikes: [{ startWeek: 30, weeks: 2, pts: 0.15 }] })
    expect(a.seasonality.spikes).toEqual([{ startWeek: 30, weeks: 2, pts: 0.15 }])
    expect(applyChanges(a, { shrinkSpikes: [{ startWeek: 0, weeks: 0, pts: 0 }] }).seasonality.spikes).toEqual([])
    expect(() => applyChanges(a, { shrinkSpikes: [{ startWeek: 3, weeks: 2, pts: 0.8 }] })).toThrow()
  })
})
