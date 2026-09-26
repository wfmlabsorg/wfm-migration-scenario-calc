import { describe, expect, test } from 'bun:test'
import { ErlangCurve, erlangB, erlangC, serviceLevel } from '../src/lib/erlang'

describe('Erlang reference values', () => {
  test('B(10, 5) = 0.01836', () => expect(erlangB(10, 5)).toBeCloseTo(0.01836, 4))
  test('C(N ≤ A) = 1', () => expect(erlangC(5, 5)).toBe(1))
  test('SL rises with agents', () => {
    const a = 40
    expect(serviceLevel(42, a, 20, 180)).toBeLessThan(serviceLevel(44, a, 20, 180))
    expect(serviceLevel(44, a, 20, 180)).toBeLessThan(serviceLevel(46, a, 20, 180))
  })
})

describe('ErlangCurve', () => {
  const cases: [number, number, number][] = [[2.3, 20 / 180, 0.8], [17.9, 20 / 360, 0.8], [123.4, 60 / 300, 0.9], [0.4, 30 / 240, 0.8]]
  test('integer SL matches the reference formula', () => {
    for (const [a, ratio] of cases) {
      const c = new ErlangCurve(a, ratio)
      for (let k = Math.ceil(a); k < Math.ceil(a) + 12; k++) expect(c.slInt(k)).toBeCloseTo(Math.max(0, serviceLevel(k, a, ratio * 100, 100)), 10)
    }
  })
  test('need(t) returns SL exactly at target, and it is the smallest such allocation', () => {
    for (const [a, ratio, t] of cases) {
      const c = new ErlangCurve(a, ratio)
      const n = c.need(t)
      expect(c.sl(n)).toBeCloseTo(t, 6)
      expect(c.sl(n - 0.05)).toBeLessThan(t)
    }
  })
  test('fractional SL is monotone in agents', () => {
    const c = new ErlangCurve(17.9, 20 / 360)
    let prev = -1
    for (let n = 0; n <= 40; n += 0.1) {
      const s = c.sl(n)
      expect(s).toBeGreaterThanOrEqual(prev - 1e-12)
      prev = s
    }
  })
  test('zero load needs nobody and is fully served', () => {
    const c = new ErlangCurve(0, 0.1)
    expect(c.need(0.8)).toBe(0)
    expect(c.sl(0)).toBe(1)
  })
})
