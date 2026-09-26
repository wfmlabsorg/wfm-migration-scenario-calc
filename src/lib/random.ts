// Seeded random numbers, so a scenario and its comparison see the same draws.

export type Rng = () => number

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function normal(rng: Rng): number {
  const u = Math.max(rng(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

function gamma(rng: Rng, shape: number): number {
  // Marsaglia–Tsang; boost for shape < 1
  if (shape < 1) return gamma(rng, shape + 1) * Math.pow(Math.max(rng(), 1e-12), 1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x: number, v: number
    do {
      x = normal(rng)
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = rng()
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

/** PERT draw from [low, most likely, high]. Always consumes random numbers, so fixing one
 *  input does not shift the stream every other input sees. */
export function pert(rng: Rng, [lo, mode, hi]: [number, number, number]): number {
  const g1 = gamma(rng, 1 + (4 * (mode - lo)) / Math.max(hi - lo, 1e-12))
  const g2 = gamma(rng, 1 + (4 * (hi - mode)) / Math.max(hi - lo, 1e-12))
  if (!(hi > lo)) return lo
  return lo + ((hi - lo) * g1) / (g1 + g2)
}

/** Binomial draw; normal approximation for large n. */
export function binomial(rng: Rng, n: number, p: number): number {
  if (n <= 0 || p <= 0) return 0
  if (p >= 1) return n
  if (n < 60) {
    let k = 0
    for (let i = 0; i < n; i++) if (rng() < p) k++
    return k
  }
  const x = Math.round(n * p + Math.sqrt(n * p * (1 - p)) * normal(rng))
  return Math.min(n, Math.max(0, x))
}
