import { describe, expect, test } from 'bun:test'
import { erlangB, erlangC, serviceLevel } from '../src/lib/erlang'
import { ErlangACurve } from '../src/lib/erlangA'
import { mulberry32 } from '../src/lib/random'

const curve = (A: number, N: number, AHT: number, APT: number, T: number) => new ErlangACurve(A, AHT / APT, T / AHT).metricsInt(N)

/** Event-by-event simulation of an M/M/N+M queue (seconds). Returns batch means and standard errors. */
function simulate(A: number, N: number, AHT: number, APT: number, T: number, arrivals = 600_000, seed = 11) {
  const rng = mulberry32(seed)
  const exp = (mean: number) => -mean * Math.log(1 - rng())
  const lambda = A / AHT
  const mu = 1 / AHT
  let now = 0
  let busy = 0
  const queue: { arrival: number; deadline: number }[] = []
  let head = 0
  const batches = 20
  const perBatch = Math.floor(arrivals / batches)
  const warm = 20_000
  const acc = Array.from({ length: batches }, () => ({ n: 0, waited: 0, abandoned: 0, inTime: 0 }))
  let arrivalsSeen = 0
  // outcome of each queued customer is only known later: remember which batch they belong to
  const batchOf: number[] = []
  while (arrivalsSeen < warm + perBatch * batches) {
    const total = lambda + busy * mu
    now += exp(1 / total)
    if (rng() < lambda / total) {
      const idx = arrivalsSeen - warm
      const bi = idx >= 0 ? Math.floor(idx / perBatch) : -1
      arrivalsSeen++
      if (bi >= 0) acc[bi].n++
      if (busy < N) {
        busy++
        if (bi >= 0) acc[bi].inTime++
      } else {
        if (bi >= 0) acc[bi].waited++
        queue.push({ arrival: now, deadline: now + exp(APT) })
        batchOf.push(bi)
      }
    } else {
      // a completion: serve the first customer still waiting (drop those whose patience ran out)
      let served = false
      while (head < queue.length) {
        const c = queue[head]
        const bi = batchOf[head]
        head++
        if (c.deadline <= now) {
          if (bi >= 0) acc[bi].abandoned++
          continue
        }
        if (bi >= 0 && now - c.arrival <= T) acc[bi].inTime++
        served = true
        break
      }
      if (!served) busy--
    }
  }
  const stat = (f: (b: (typeof acc)[0]) => number) => {
    const xs = acc.map(f)
    const m = xs.reduce((s, x) => s + x, 0) / xs.length
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
    return { mean: m, se: sd / Math.sqrt(xs.length) }
  }
  return {
    pw: stat((b) => b.waited / b.n),
    ab: stat((b) => b.abandoned / b.n),
    sl: stat((b) => b.inTime / b.n),
  }
}

const POINTS: [string, number, number, number, number, number][] = [
  // name, A, N, AHT, APT, T
  ['base', 10, 12, 300, 180, 20],
  ['overload', 20, 17, 300, 120, 30],
  ['patient', 10, 12, 300, 30000, 20],
  ['impatient', 5, 5, 300, 10, 20],
  ['chat-like', 100, 98, 600, 300, 60],
  ['light', 0.5, 1, 240, 60, 30],
]

describe('Erlang A matches an event-by-event simulation', () => {
  for (const [name, A, N, AHT, APT, T] of POINTS)
    test(name, () => {
      const exact = curve(A, N, AHT, APT, T)
      const sim = simulate(A, N, AHT, APT, T)
      for (const k of ['pw', 'ab', 'sl'] as const) {
        const tol = Math.max(0.004, 4 * sim[k].se)
        expect(Math.abs(exact[k] - sim[k].mean), `${name} ${k}: exact ${exact[k].toFixed(4)} sim ${sim[k].mean.toFixed(4)}`).toBeLessThan(tol)
      }
    }, 30_000)
})

describe('limits and identities', () => {
  test('very patient customers reproduce Erlang C (series path)', () => {
    for (const [A, N, T] of [[10, 12, 20], [50, 55, 20], [100, 110, 60]] as const) {
      const m = curve(A, N, 300, 1e9, T)
      expect(m.pw).toBeCloseTo(erlangC(N, A), 5)
      expect(m.sl).toBeCloseTo(serviceLevel(N, A, T, 300), 5)
      expect(m.ab).toBeLessThan(1e-5)
    }
  })
  test('very impatient customers reproduce Erlang B (loss system)', () => {
    const A = 10
    const N = 10
    const m = curve(A, N, 300, 1e-6, 20)
    const B = erlangB(N, A)
    expect(m.pw).toBeCloseTo(B, 6)
    expect(m.ab).toBeCloseTo(B, 6)
    expect(m.sl).toBeCloseTo(1 - B, 6)
  })
  test('series agrees with the integral form (Simpson quadrature)', () => {
    for (const [A, N, AHT, APT, T] of [[10, 12, 300, 180, 20], [20, 17, 300, 120, 30], [100, 98, 600, 300, 60]] as const) {
      const h = AHT / APT
      const tau = T / AHT
      const f = (s: number, extra: number) => (A * -Math.expm1(-h * s)) / h - (N + extra) * s
      // integrate exp(f) with log-scaling relative to its maximum
      const integrate = (a: number, b: number, extra: number, steps = 200_000) => {
        const dx = (b - a) / steps
        let mx = -Infinity
        for (let i = 0; i <= steps; i++) mx = Math.max(mx, f(a + i * dx, extra))
        let s = 0
        for (let i = 0; i <= steps; i++) s += (i === 0 || i === steps ? 1 : i % 2 ? 4 : 2) * Math.exp(f(a + i * dx, extra) - mx)
        return { value: (s * dx) / 3, logScale: mx }
      }
      const B = erlangB(N, A)
      const tail = integrate(0, 60, 0)
      const waited = integrate(0, tau, h)
      // Z = 1/B − 1 + N·∫e^f;  P(wait) = N·∫e^f / Z;  SL = (1/B − 1 + N·∫_0^τ e^{f−hs}) / Z
      const I = tail.value * Math.exp(tail.logScale)
      const Iw = waited.value * Math.exp(waited.logScale)
      const Z = 1 / B - 1 + N * I
      const m = curve(A, N, AHT, APT, T)
      expect(m.pw).toBeCloseTo((N * I) / Z, 7)
      expect(m.sl).toBeCloseTo((1 / B - 1 + N * Iw) / Z, 7)
    }
  })
  test('proven inequalities', () => {
    for (const [A, N, APT] of [[10, 8, 120], [10, 12, 60], [50, 45, 300], [5, 5, 30], [200, 190, 200]] as const) {
      const m = curve(A, N, 300, APT, 20)
      expect(1 - m.ab).toBeLessThanOrEqual(N / A + 1e-9) // throughput can't exceed capacity
      expect(m.sl).toBeLessThanOrEqual(1 - m.ab + 1e-12) // only answered contacts count
      const far = curve(A, N, 300, APT, 1e7)
      expect(far.sl).toBeCloseTo(1 - far.ab, 6) // with a huge threshold, SL = answered share
      if (N > A) expect(m.pw).toBeLessThanOrEqual(erlangC(N, A) + 1e-12)
    }
  })
  test('overload is stable and handles very large loads without overflow', () => {
    for (const [A, N] of [[800, 700], [1500, 1400], [3000, 3050]] as const) {
      const m = curve(A, N, 300, 120, 20)
      for (const v of [m.pw, m.ab, m.sl]) expect(Number.isFinite(v) && v >= 0 && v <= 1).toBe(true)
    }
  })
})

describe('curve behaviour', () => {
  const c = new ErlangACurve(40, 300 / 120, 20 / 300)
  test('service rises and abandonment falls as agents are added', () => {
    let prevSl = -1
    let prevAb = 2
    for (let n = 0; n <= 70; n += 0.5) {
      expect(c.sl(n)).toBeGreaterThanOrEqual(prevSl - 1e-12)
      expect(c.abandon(n)).toBeLessThanOrEqual(prevAb + 1e-12)
      prevSl = c.sl(n)
      prevAb = c.abandon(n)
    }
  })
  test('need() returns the target exactly, can be below the load, and need(0) is 0', () => {
    for (const t of [0.2, 0.5, 0.8, 0.9]) expect(c.sl(c.need(t))).toBeCloseTo(t, 9)
    expect(c.need(0)).toBe(0)
    expect(new ErlangACurve(40, 300 / 30, 20 / 300).need(0.3)).toBeLessThan(40) // impatient callers: fewer agents than load
  })
  test('fast enough: 468 cold curves with need() and sl() under 50 ms', () => {
    const t0 = performance.now()
    for (let i = 0; i < 468; i++) {
      const cc = new ErlangACurve(20 + i * 0.37, 300 / 120, 20 / 300)
      cc.sl(cc.need(0.8) - 2)
    }
    expect(performance.now() - t0).toBeLessThan(50)
  })
})
