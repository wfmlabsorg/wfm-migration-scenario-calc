// Erlang B / C and service level.
// erlangB, erlangC and serviceLevel follow the WFM Labs Erlang Suite (Jagerman recursion, no
// factorials). ErlangCurve adds what a weekly simulator needs: fractional agents and a
// single-pass inverse, so finding the agents for a target and reading the service level at
// any allocation reuse one recursion instead of restarting it for every candidate.

export function erlangB(servers: number, a: number): number {
  if (servers < 0 || a < 0) return 0
  let b = 1.0
  for (let i = 1; i <= servers; i++) b = (a * b) / (i + a * b)
  return b
}

export function erlangC(servers: number, a: number): number {
  if (servers <= a) return 1.0
  const eb = erlangB(servers, a)
  const d = servers - a * (1 - eb)
  return d <= 0 ? 1.0 : (servers * eb) / d
}

export function serviceLevel(servers: number, a: number, targetTime: number, aht: number): number {
  if (servers <= a) return 0
  return 1 - erlangC(servers, a) * Math.exp(-((servers - a) * targetTime) / aht)
}

/** Service level as a function of agents for one offered load and one answer threshold. */
export class ErlangCurve {
  private b: number[] = [1] // Erlang B at k = 0, 1, 2 …
  constructor(
    readonly a: number, // offered load, Erlangs
    readonly ratio: number, // answer threshold / handle time
  ) {}

  private extend(k: number) {
    const { a } = this
    for (let i = this.b.length; i <= k; i++) {
      const prev = this.b[i - 1]
      this.b.push((a * prev) / (i + a * prev))
    }
  }

  /** Service level at an integer number of agents. */
  slInt(k: number): number {
    const { a } = this
    if (a <= 0) return 1
    if (k <= a) return 0
    this.extend(k)
    const bk = this.b[k]
    const c = (k * bk) / (k - a * (1 - bk))
    return Math.min(1, Math.max(0, 1 - c * Math.exp(-(k - a) * this.ratio)))
  }

  /** Service level at fractional agents: linear between the neighbouring integers. */
  sl(n: number): number {
    if (this.a <= 0) return 1
    if (!(n > 0)) return 0
    const lo = Math.floor(n)
    const w = n - lo
    return (1 - w) * this.slInt(lo) + w * this.slInt(lo + 1)
  }

  /** Fewest (fractional) agents reaching the target; sl(need(t)) === t. */
  need(target: number): number {
    if (this.a <= 0) return 0
    const t = Math.min(target, 0.9999)
    let k = Math.max(1, Math.floor(this.a) + 1)
    while (this.slInt(k) < t) k++
    const prev = k - 1
    const slPrev = this.slInt(prev)
    const slK = this.slInt(k)
    return slK === slPrev ? k : prev + (t - slPrev) / (slK - slPrev)
  }
}

const cache = new Map<string, ErlangCurve>()

/** Memoised curve; weeks before any runoff repeat the same loads. */
export function curve(a: number, ratio: number): ErlangCurve {
  const key = `${a.toFixed(4)}|${ratio.toFixed(6)}`
  let c = cache.get(key)
  if (!c) {
    if (cache.size > 20000) cache.clear()
    c = new ErlangCurve(Number(a.toFixed(4)), ratio)
    cache.set(key, c)
  }
  return c
}
