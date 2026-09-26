// Erlang A (M/M/N+M): Poisson arrivals, exponential handling (mean AHT), N agents, and customers
// who give up after an exponential patience time (mean APT). Exact, numerically stable metrics.
//
// Notation (all dimensionless): A = offered load in Erlangs, h = AHT / APT, τ = T / AHT.
// Queue distribution relative to "all agents busy, nobody waiting":
//   q₀ = 1, q_k = q_{k−1} · A / (N + k·h)                       (k customers waiting)
//   states with a free agent sum to (1/B − 1) on that scale, B = Erlang B(N, A)
//   Z = 1/B − 1 + Σ q_k
// A customer who arrives to find k waiting reaches an agent after k+1 "advances"; the m-th
// advance happens at rate N + m·h (a completion or someone ahead giving up) while the customer
// gives up at rate h. That gives, with F_k a negative-binomial CDF (x = 1 − e^{−hτ}, b = N/h + 1,
// t₀ = e^{−(N+h)τ}, t_j = t_{j−1}·x·(b+j−1)/j):
//   P(wait)              = Σ q_k / Z
//   P(abandon)           = Σ q_k · (k+1)h / (N+(k+1)h) / Z
//   answered within T    = [ (1/B − 1) + Σ q_k · N/(N+(k+1)h) · (1 − F_k) ] / Z   (÷ all offered)
//   speed of answer (answered only, in AHT units) = Σ q_k · N/(N+(k+1)h) · Σ_{j=1..k+1} 1/(N+jh) / (Z·(1 − P(abandon)))
// Very patient customers (h → 0) reduce to Erlang C.
import { ErlangCurve } from './erlang'

export interface AMetrics {
  pw: number // probability of waiting
  ab: number // share of offered that abandon
  sl: number // answered within T ÷ all offered
  asa: number // mean wait of answered contacts, in units of AHT
}

export class ErlangACurve {
  private b: number[] = [1]
  private cache = new Map<number, AMetrics>()
  private c: ErlangCurve | null
  constructor(
    readonly a: number, // offered load, Erlangs
    readonly h: number, // AHT ÷ patience
    readonly tau: number, // answer threshold ÷ AHT
  ) {
    this.c = h < 1e-9 ? new ErlangCurve(a, tau) : null
  }

  private bAt(n: number): number {
    for (let i = this.b.length; i <= n; i++) {
      const prev = this.b[i - 1]
      this.b.push((this.a * prev) / (i + this.a * prev))
    }
    return this.b[n]
  }

  metricsInt(N: number): AMetrics {
    const hit = this.cache.get(N)
    if (hit) return hit
    const m = this.compute(N)
    this.cache.set(N, m)
    return m
  }

  private compute(N: number): AMetrics {
    const { a, h, tau } = this
    if (a <= 0) return { pw: 0, ab: 0, sl: 1, asa: 0 }
    if (N <= 0) return { pw: 1, ab: 1, sl: 0, asa: 0 }
    if (this.c) {
      // infinitely patient: Erlang C; an overloaded queue serves at most N/A of arrivals
      const sl = this.c.slInt(N)
      if (N <= a) return { pw: 1, ab: 1 - N / a, sl: 0, asa: Infinity }
      const B = this.bAt(N)
      const pw = (N * B) / (N - a * (1 - B))
      return { pw, ab: 0, sl, asa: pw / (N - a) }
    }
    const B = this.bAt(N)
    if (B < 1e-300) return { pw: 0, ab: 0, sl: 1, asa: 0 }
    const x = -Math.expm1(-h * tau)
    const bb = N / h + 1
    let q = 1
    let Z0 = 1 / B - 1
    let Sw = 0
    let Sab = 0
    let Ssl = 0
    let Sasa = 0
    let H = 0
    let tS = 1 // scaled negative-binomial term; actual = tS · e^{logS}
    let Fs = 0
    let logS = -(N + h) * tau
    const kStar = Math.max(0, (a - N) / h)
    const kMax = Math.min(2_000_000, Math.ceil(kStar + 9 * Math.sqrt(a / h) + 200))
    for (let k = 0; k <= kMax; k++) {
      Fs += tS
      const cdf = Math.max(0, 1 - Fs * Math.exp(logS))
      const denom = N + (k + 1) * h
      const ps = N / denom
      H += 1 / denom
      Sw += q
      Ssl += q * ps * cdf
      Sab += q * (1 - ps)
      Sasa += q * ps * H
      tS *= (x * (bb + k)) / (k + 1)
      if (tS > 1e200) {
        tS *= 1e-200
        Fs *= 1e-200
        logS += 200 * Math.LN10
      }
      const r = a / denom
      q *= r
      if (k + 1 > kStar && r < 1 && (q * r) / (1 - r) < 1e-16 * (Z0 + Sw)) break
      if (q > 1e250) {
        q *= 1e-250
        Z0 *= 1e-250
        Sw *= 1e-250
        Ssl *= 1e-250
        Sab *= 1e-250
        Sasa *= 1e-250
      }
    }
    const Z = Z0 + Sw
    const ab = Sab / Z
    return {
      pw: Math.min(1, Sw / Z),
      ab: Math.min(1, Math.max(0, ab)),
      sl: Math.min(1, Math.max(0, (Z0 + Ssl) / Z)),
      asa: ab < 1 ? Sasa / (Z * (1 - ab)) : Infinity,
    }
  }

  private interp(n: number, f: (m: AMetrics) => number): number {
    if (this.a <= 0) return f({ pw: 0, ab: 0, sl: 1, asa: 0 })
    if (!(n > 0)) return f(this.metricsInt(0))
    const lo = Math.floor(n)
    const w = n - lo
    return (1 - w) * f(this.metricsInt(lo)) + w * f(this.metricsInt(lo + 1))
  }

  /** Answered within the threshold ÷ all offered, at fractional agents. */
  sl(n: number): number {
    return this.interp(n, (m) => m.sl)
  }

  /** Share of offered contacts that give up, at fractional agents. */
  abandon(n: number): number {
    return this.interp(n, (m) => m.ab)
  }

  /** Fewest (fractional) agents reaching the target; can be below the load. need(0) = 0. */
  need(target: number): number {
    if (this.a <= 0 || !(target > 0)) return 0
    const t = Math.min(target, 0.9999)
    let hi = Math.max(1, Math.ceil(this.a))
    while (this.metricsInt(hi).sl < t && hi < 1e7) hi *= 2
    let lo = 0
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (this.metricsInt(mid).sl >= t) hi = mid
      else lo = mid
    }
    const slLo = this.metricsInt(hi - 1).sl
    const slHi = this.metricsInt(hi).sl
    return slHi === slLo ? hi : hi - 1 + (t - slLo) / (slHi - slLo)
  }
}

const cacheA = new Map<string, ErlangACurve>()

/** Memoised Erlang A curve (load, handle-time ÷ patience, threshold ÷ handle time). */
export function curveA(a: number, h: number, tau: number): ErlangACurve {
  const key = `${a.toFixed(4)}|${h.toFixed(6)}|${tau.toFixed(6)}`
  let c = cacheA.get(key)
  if (!c) {
    if (cacheA.size > 20000) cacheA.clear()
    c = new ErlangACurve(Number(a.toFixed(4)), h, tau)
    cacheA.set(key, c)
  }
  return c
}
