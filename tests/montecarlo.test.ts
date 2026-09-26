import { describe, expect, test } from 'bun:test'
import { DEFAULTS } from '../src/lib/defaults'
import { run } from '../src/lib/engine'
import { simulate } from '../src/lib/montecarlo'
import { mulberry32, pert } from '../src/lib/random'
import type { Inputs } from '../src/lib/types'

describe('Monte Carlo', () => {
  test('the same seed gives identical results (common random numbers)', () => {
    const a = simulate(DEFAULTS, 200, 42)
    const b = simulate(DEFAULTS, 200, 42)
    expect(a).toEqual(b)
  })

  test('point ranges reproduce the deterministic run', () => {
    const i: Inputs = structuredClone(DEFAULTS)
    // every assumption confirmed at its likely value: nothing is drawn except binomial attrition
    for (const a of Object.values(i.assumptions)) if (a.range) a.range = [a.range[1], a.range[1], a.range[1]]
    const draws = 400
    const mc = simulate(i, draws, 7)
    const det = run(i)
    expect(mc.freezeEnd.p50).toBe(det.freezeEnd)
    // headcount: the only randomness left is binomial attrition, so the median tracks the expected path
    for (const w of [5, 13, 17, 23]) {
      expect(Math.abs(mc.p50.heads[w] - det.weeks[w].heads)).toBeLessThan(2)
      expect(Math.abs(mc.p50.voice[w] - det.weeks[w].voice.sl)).toBeLessThan(0.03)
    }
  })

  test('PERT respects its bounds and centres near its mean', () => {
    const rng = mulberry32(1)
    const xs = Array.from({ length: 20000 }, () => pert(rng, [2, 5, 14]))
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(2)
    expect(Math.max(...xs)).toBeLessThanOrEqual(14)
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length
    expect(mean).toBeCloseTo((2 + 4 * 5 + 14) / 6, 1)
  })

  test('1,000 futures run in a few seconds', () => {
    const t0 = performance.now()
    simulate(DEFAULTS, 1000, 3)
    expect(performance.now() - t0).toBeLessThan(8000)
  })
})
