// The book of business as shares rather than dated step-downs. Each cell (contract type ×
// relationship health) holds a share of the workload and fate probabilities (transfer, exit,
// re-platform). Departure weeks follow the same rules as the desktop pack:
//   transfer   → its wave: freeze end + wave offset + slip
//   exit       → fixed-term: uniform over the expiry window (absolute weeks);
//                rolling: freeze end + PERT(notice). An exit that would land on or after the
//                client's wave transfers at the wave instead (the late-exit rule).
//   re-platform → freeze end + PERT(offset), capped at the wave.
// expectedBook() is the closed-form expectation (no random numbers): the deterministic line.
// sampledBook() draws K client-equivalents so the Monte Carlo sees real staircases.
import { pert, type Rng } from './random'
import type { Book, BookCurve, Fate, Inputs, People, Triple } from './types'

// ---- regularised incomplete beta (Numerical Recipes betacf), accurate to ~1e-12 ----

function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let y = x
  const t = x + 5.5 - (x + 0.5) * Math.log(x + 5.5)
  let s = 1.000000000190015
  for (const ci of c) s += ci / ++y
  return -t + Math.log((2.5066282746310005 * s) / x)
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 300
  const EPS = 3e-14
  const FPMIN = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}

/** Regularised incomplete beta I_x(a, b) = P(Beta(a, b) ≤ x). */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b
}

/** P(PERT(lo, mode, hi) ≤ v): the same Beta the sampler in random.ts draws. */
export function pertCdf(v: number, [lo, mode, hi]: Triple): number {
  if (!(hi > lo)) return v >= lo ? 1 : 0
  const a = 1 + (4 * (mode - lo)) / (hi - lo)
  const b = 1 + (4 * (hi - mode)) / (hi - lo)
  return betaCdf((v - lo) / (hi - lo), a, b)
}

// ---- discrete week distributions ----

/** P(round(x) = k) for x ~ PERT, i.e. the mass on integer week offset k. */
const pertMass = (k: number, t: Triple) => pertCdf(k + 0.5, t) - pertCdf(k - 0.5, t)

function pmfFromPert(t: Triple, maxK: number): number[] {
  const p = new Array(maxK + 1).fill(0)
  let acc = 0
  for (let k = 0; k <= maxK; k++) {
    p[k] = Math.max(0, pertMass(k, t))
    acc += p[k]
  }
  if (acc < 1) p[maxK] += 1 - acc // mass beyond the horizon lands on the last bucket (it never leaves in time)
  return p
}

/** Uniform over the integer weeks lo…hi (absolute). */
function pmfUniform(lo: number, hi: number, maxK: number): number[] {
  const p = new Array(maxK + 1).fill(0)
  const a = Math.max(0, Math.round(lo))
  const b = Math.max(a, Math.round(hi))
  const n = b - a + 1
  for (let k = a; k <= b; k++) p[Math.min(k, maxK)] += 1 / n
  return p
}

const CONTRACTS = ['fixed', 'evergreen', 'tfc'] as const
const HEALTH = ['green', 'amber', 'red'] as const
const FATES = ['transfer', 'exit', 'replatform'] as const

function norm3<K extends string>(o: Record<K, number>, keys: readonly K[]): Record<K, number> {
  const vals = keys.map((k) => Math.max(0, Number(o[k]) || 0))
  const s = vals.reduce((a, b) => a + b, 0)
  const out = {} as Record<K, number>
  const already = Math.abs(s - 1) < 1e-9 // leave exact shares untouched (links round-trip byte for byte)
  keys.forEach((k, i) => (out[k] = already ? vals[i] : s > 0 ? vals[i] / s : 1 / keys.length))
  return out
}

/** Mixes and priors as proper shares (sum 1, non-negative), waves as shares of transferring work summing to 1. */
export function normaliseMixes(inp: Inputs): void {
  const b = inp.book
  b.contractMix = norm3(b.contractMix, CONTRACTS)
  b.healthMix = norm3(b.healthMix, HEALTH)
  for (const h of HEALTH) b.priors[h] = norm3(b.priors[h], FATES) as Fate
}

/** Waves as shares of transferring work: normalised to sum 1 (remainder on the last wave), in time order. */
export function bookWaves(book: Book): { offset: number; share: number }[] {
  const ws = book.waves.map((w) => ({ offset: Math.max(0, Math.round(w.weeksAfterFreeze)), share: Math.max(0, w.pct) })).sort((a, b) => a.offset - b.offset)
  if (!ws.length) return []
  const sum = ws.reduce((s, w) => s + w.share, 0)
  if (sum > 1) ws.forEach((w) => (w.share /= sum))
  else ws[ws.length - 1].share += 1 - sum
  return ws
}

interface Cell { share: number; contract: (typeof CONTRACTS)[number]; fate: Fate }

function cells(book: Book): Cell[] {
  const out: Cell[] = []
  const cm = norm3(book.contractMix, CONTRACTS)
  const hm = norm3(book.healthMix, HEALTH)
  for (const c of CONTRACTS) for (const h of HEALTH) {
    const share = cm[c] * hm[h]
    if (share > 0) out.push({ share, contract: c, fate: norm3(book.priors[h], FATES) as Fate })
  }
  return out
}

const num = (x: unknown, lo: number, hi: number, fb: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fb)
/** Week ranges are whole weeks: the closed form and the sampler must land the same point on the same week. */
const triple = (x: unknown, lo: number, hi: number, fb: Triple): Triple => {
  if (!Array.isArray(x) || x.length !== 3) return [...fb]
  const t = x.map((v, i) => Math.round(num(v, lo, hi, fb[i]))) as Triple
  return [Math.min(t[0], t[1]), t[1], Math.max(t[2], t[1])]
}
export const BOOK_LIMITS = { notice: 104, replatform: 104, slip: 26, expiry: 156 } as const

/** A book block from a link or card: finite, clamped, shares normalised; anything malformed falls back. */
export function sanitiseBook(raw: unknown, fb: Book): Book {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const mix = <K extends string>(x: unknown, keys: readonly K[], fbm: Record<K, number>) => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    const out = {} as Record<K, number>
    for (const k of keys) out[k] = num(o[k], 0, 1, fbm[k])
    return norm3(out, keys)
  }
  const pri = (x: unknown) => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    const out = {} as Book['priors']
    for (const h of HEALTH) out[h] = mix(o[h], FATES, fb.priors[h]) as Fate
    return out
  }
  const fe = Array.isArray(r.fixedExpiry) && r.fixedExpiry.length === 2 ? [num(r.fixedExpiry[0], 0, BOOK_LIMITS.expiry, fb.fixedExpiry[0]), num(r.fixedExpiry[1], 0, BOOK_LIMITS.expiry, fb.fixedExpiry[1])] : [...fb.fixedExpiry]
  const waves = Array.isArray(r.waves)
    ? r.waves.filter((w: unknown) => !!w && typeof w === 'object').map((w: any) => ({ weeksAfterFreeze: Math.round(num(w.weeksAfterFreeze, 0, 77, 0)), pct: num(w.pct, 0, 1, 0) })).slice(0, 4)
    : fb.waves.map((w) => ({ ...w }))
  const en = (r.exitNotice && typeof r.exitNotice === 'object' ? r.exitNotice : {}) as Record<string, unknown>
  return {
    mode: r.mode === 'book' ? 'book' : 'manual',
    contractMix: mix(r.contractMix, CONTRACTS, fb.contractMix),
    fixedExpiry: [Math.round(Math.min(fe[0], fe[1])), Math.round(Math.max(fe[0], fe[1]))],
    healthMix: mix(r.healthMix, HEALTH, fb.healthMix),
    priors: pri(r.priors),
    exitNotice: { evergreen: triple(en.evergreen, 0, BOOK_LIMITS.notice, fb.exitNotice.evergreen), tfc: triple(en.tfc, 0, BOOK_LIMITS.notice, fb.exitNotice.tfc) },
    replatformOffset: triple(r.replatformOffset, 0, BOOK_LIMITS.replatform, fb.replatformOffset),
    waves,
    waveSlip: triple(r.waveSlip, 0, BOOK_LIMITS.slip, fb.waveSlip),
    granularity: Math.round(num(r.granularity, 5, 200, fb.granularity)),
  }
}

export function sanitisePeople(raw: unknown, fb: People): People {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const target = r.retentionTarget === 'transfer' || r.retentionTarget === 'both' || r.retentionTarget === 'release' ? r.retentionTarget : fb.retentionTarget
  return {
    split: r.split === true,
    postMultTransfer: num(r.postMultTransfer, 0.5, 8, fb.postMultTransfer), // a transfer group can be calmer than baseline
    postMultRelease: num(r.postMultRelease, 1, 8, fb.postMultRelease),
    retentionEffect: num(r.retentionEffect, 0, 1, fb.retentionEffect),
    retentionTarget: target,
  }
}

/** Throws a readable message when a book block is not well formed (the analyst's set_book). */
export function validateBook(raw: unknown): Book {
  if (!raw || typeof raw !== 'object') throw new Error('book must be an object')
  const b = raw as Record<string, any>
  if (b.mode !== 'manual' && b.mode !== 'book') throw new Error('book.mode must be "manual" or "book"')
  const sum1 = (o: Record<string, unknown>, keys: readonly string[], name: string) => {
    let s = 0
    for (const k of keys) {
      const v = o?.[k]
      if (typeof v !== 'number' || !(v >= 0 && v <= 1)) throw new Error(`${name}.${k} must be a share 0–1`)
      s += v
    }
    if (Math.abs(s - 1) > 1e-6) throw new Error(`${name} shares must sum to 1 (got ${s.toFixed(4)})`)
  }
  sum1(b.contractMix, CONTRACTS, 'contractMix')
  sum1(b.healthMix, HEALTH, 'healthMix')
  for (const h of HEALTH) sum1(b.priors?.[h], FATES, `priors.${h}`)
  const tri = (t: unknown, lo: number, hi: number, name: string) => {
    if (!Array.isArray(t) || t.length !== 3 || !t.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new Error(`${name} must be [low, likely, high]`)
    if (!t.every((x) => Number.isInteger(x))) throw new Error(`${name} must be whole weeks`)
    if (!(t[0] <= t[1] && t[1] <= t[2])) throw new Error(`${name} must satisfy low ≤ likely ≤ high`)
    if (t[0] < lo || t[2] > hi) throw new Error(`${name} must lie within ${lo}–${hi} weeks`)
  }
  tri(b.exitNotice?.evergreen, 0, BOOK_LIMITS.notice, 'exitNotice.evergreen')
  tri(b.exitNotice?.tfc, 0, BOOK_LIMITS.notice, 'exitNotice.tfc')
  tri(b.replatformOffset, 0, BOOK_LIMITS.replatform, 'replatformOffset')
  tri(b.waveSlip, 0, BOOK_LIMITS.slip, 'waveSlip')
  const fe = b.fixedExpiry
  if (!Array.isArray(fe) || fe.length !== 2 || !fe.every((x) => Number.isInteger(x) && x >= 0 && x <= BOOK_LIMITS.expiry) || fe[0] > fe[1]) throw new Error(`fixedExpiry must be two whole weeks [first, last] within 0–${BOOK_LIMITS.expiry}`)
  if (!Array.isArray(b.waves) || b.waves.length > 4) throw new Error('waves must be a list of at most 4')
  let ws = 0
  const offsets = new Set<number>()
  for (const w of b.waves) {
    if (!Number.isInteger(w?.weeksAfterFreeze) || w.weeksAfterFreeze < 0 || w.weeksAfterFreeze > 77) throw new Error('wave weeksAfterFreeze must be a whole number 0–77')
    if (offsets.has(w.weeksAfterFreeze)) throw new Error('two waves share the same week; merge them')
    offsets.add(w.weeksAfterFreeze)
    if (!(typeof w.pct === 'number' && w.pct >= 0 && w.pct <= 1)) throw new Error('wave pct must be 0–1 (share of transferring work)')
    ws += w.pct
  }
  if (ws > 1 + 1e-3) throw new Error('wave shares of transferring work must sum to at most 1')
  if (!Number.isInteger(b.granularity) || b.granularity < 5 || b.granularity > 200) throw new Error('granularity must be a whole number 5–200')
  return sanitiseBook(b, b as Book)
}

const shiftPmf = (p: number[], by: number, maxK: number): number[] => {
  const out = new Array(maxK + 1).fill(0)
  for (let k = 0; k < p.length; k++) {
    const j = Math.min(maxK, Math.max(0, k + by))
    out[j] += p[k]
  }
  return out
}
const tail = (p: number[]) => { // S[k] = P(X > k)
  const s = new Array(p.length).fill(0)
  let acc = 0
  for (let k = p.length - 1; k >= 0; k--) { s[k] = acc; acc += p[k] }
  return s
}

/**
 * The expected departure curve of the book (shares of the week-0 book), in closed form.
 * `freezeEnd` is the announcement week. Weeks run 0 … horizon−1; departures at week w mean the
 * work is gone from week w on. Anything that would leave after the horizon stays.
 */
/** Last week any departure can land, so the closed form sees every distribution's full support. */
function supportEnd(book: Book, freezeEnd: number, W: number): number {
  const maxOffset = book.waves.reduce((m, w) => Math.max(m, Math.round(w.weeksAfterFreeze)), 0)
  return Math.max(W, freezeEnd + maxOffset + book.waveSlip[2], freezeEnd + book.exitNotice.evergreen[2], freezeEnd + book.exitNotice.tfc[2], freezeEnd + book.replatformOffset[2], book.fixedExpiry[1]) + 1
}

export function expectedBook(inp: Inputs, freezeEnd: number): BookCurve {
  const W = inp.horizonWeeks
  const book = inp.book
  const maxK = supportEnd(book, freezeEnd, W) // every departure lands inside 0…maxK, so late fates are counted right
  const remaining = new Array(W).fill(0)
  const transferLeaving = new Array(W).fill(0)
  const exitLeaving = new Array(W).fill(0)
  const replatformLeaving = new Array(W).fill(0)
  const implied = { transfer: 0, exit: 0, replatform: 0 }

  const waves = bookWaves(book)
  const slip = pmfFromPert(book.waveSlip, maxK)
  // wave week pmfs (absolute weeks), one per wave
  const wavePmf = waves.map((w) => shiftPmf(slip, freezeEnd + w.offset, maxK))
  const waveTail = wavePmf.map(tail)
  const notice = {
    evergreen: shiftPmf(pmfFromPert(book.exitNotice.evergreen, maxK), freezeEnd, maxK),
    tfc: shiftPmf(pmfFromPert(book.exitNotice.tfc, maxK), freezeEnd, maxK),
    fixed: pmfUniform(book.fixedExpiry[0], book.fixedExpiry[1], maxK),
  }
  const repl = shiftPmf(pmfFromPert(book.replatformOffset, maxK), freezeEnd, maxK)
  const replTail = tail(repl)
  const noticeTail = { evergreen: tail(notice.evergreen), tfc: tail(notice.tfc), fixed: tail(notice.fixed) }

  // per-week departures, accumulated as shares of the week-0 book
  const depT = new Array(maxK + 1).fill(0)
  const depE = new Array(maxK + 1).fill(0)
  const depR = new Array(maxK + 1).fill(0)
  for (const c of cells(book)) {
    const ex = notice[c.contract]
    const exTail = noticeTail[c.contract]
    for (let j = 0; j < waves.length; j++) {
      const wj = c.share * waves[j].share
      const pw = wavePmf[j]
      const sw = waveTail[j]
      for (let k = 0; k <= maxK; k++) {
        // transfers leave at the wave
        depT[k] += wj * c.fate.transfer * pw[k]
        // exits: at the exit week if before the wave; otherwise they transfer at the wave (late-exit rule)
        const exBeforeWave = ex[k] * sw[k] // exit at k and wave later than k
        const exAtWave = pw[k] * (exTail[k] + ex[k]) // wave at k and exit at k or later
        depE[k] += wj * c.fate.exit * exBeforeWave
        depT[k] += wj * c.fate.exit * exAtWave
        // re-platforming: at its own week if before the wave, else at the wave (still re-platformed)
        depR[k] += wj * c.fate.replatform * (repl[k] * sw[k] + pw[k] * (replTail[k] + repl[k]))
      }
    }
    if (!waves.length) {
      // no waves: transfers never leave (they count as transfers that stay); exits and re-platforming leave on their own weeks
      implied.transfer += c.share * c.fate.transfer
      for (let k = 0; k <= maxK; k++) {
        depE[k] += c.share * c.fate.exit * ex[k]
        depR[k] += c.share * c.fate.replatform * repl[k]
      }
    }
  }
  let left = 1
  for (let w = 0; w < W; w++) {
    transferLeaving[w] = depT[w]
    exitLeaving[w] = depE[w]
    replatformLeaving[w] = depR[w]
    left -= depT[w] + depE[w] + depR[w]
    remaining[w] = Math.max(0, left)
  }
  for (let k = 0; k <= maxK; k++) {
    implied.transfer += depT[k]
    implied.exit += depE[k]
    implied.replatform += depR[k]
  }
  // fates over the whole book (departures inside and beyond the horizon), so they are the book's odds, not the horizon's
  const total = implied.transfer + implied.exit + implied.replatform || 1
  const impliedFates: Fate = { transfer: implied.transfer / total, exit: implied.exit / total, replatform: implied.replatform / total }
  return { remaining, transferLeaving, exitLeaving, replatformLeaving, impliedFates, transferShareAtAnnouncement: tauOf(remaining, transferLeaving, freezeEnd, W) }
}

/** τ: share of the work still at the source at the announcement that will transfer (within the horizon). */
function tauOf(remaining: number[], transferLeaving: number[], freezeEnd: number, W: number): number {
  const at = Math.min(Math.max(0, freezeEnd), W)
  const here = at === 0 ? 1 : remaining[at - 1]
  if (here <= 1e-12) return 0
  let t = 0
  for (let w = at; w < W; w++) t += transferLeaving[w]
  return Math.min(1, t / here)
}

/**
 * One future's departure staircase: K client-equivalents (share 1/K each) draw a cell, a fate,
 * a wave and a departure week. The slip is drawn once for the future. Consumes `rng` only.
 */
export function sampledBook(inp: Inputs, freezeEnd: number, rng: Rng): BookCurve {
  const W = inp.horizonWeeks
  const book = inp.book
  const K = Math.max(5, Math.min(200, Math.round(book.granularity) || 40))
  const cs = cells(book)
  const cum: number[] = []
  let acc = 0
  for (const c of cs) { acc += c.share; cum.push(acc) }
  const waves = bookWaves(book)
  const slip = Math.round(pert(rng, book.waveSlip))
  const waveWeek = waves.map((w) => freezeEnd + w.offset + slip)
  const remaining = new Array(W).fill(0)
  const transferLeaving = new Array(W).fill(0)
  const exitLeaving = new Array(W).fill(0)
  const replatformLeaving = new Array(W).fill(0)
  const implied = { transfer: 0, exit: 0, replatform: 0 }
  const beyond = Infinity // no wave: a transfer never leaves, and no exit can be "late"
  for (let i = 0; i < K; i++) {
    if (!cs.length) break
    const u = rng() * (acc || 1)
    let ci = cum.findIndex((x) => u < x)
    if (ci < 0) ci = cs.length - 1
    const cell = cs[ci]
    const uf = rng()
    const fate = uf < cell.fate.transfer ? 'transfer' : uf < cell.fate.transfer + cell.fate.exit ? 'exit' : 'replatform'
    let wj = -1
    if (waves.length) {
      const uw = rng()
      let s = 0
      for (let j = 0; j < waves.length; j++) { s += waves[j].share; if (uw < s) { wj = j; break } }
      if (wj < 0) wj = waves.length - 1
    }
    const wave = wj >= 0 ? waveWeek[wj] : beyond
    const ud = rng() // consumed for every client so the streams stay aligned across fates
    let dep: number
    let kind: 'transfer' | 'exit' | 'replatform'
    if (fate === 'transfer') { dep = wave; kind = 'transfer' }
    else if (fate === 'exit') {
      const e = cell.contract === 'fixed'
        ? Math.min(book.fixedExpiry[1], book.fixedExpiry[0] + Math.floor(ud * (book.fixedExpiry[1] - book.fixedExpiry[0] + 1))) // discrete uniform over whole weeks
        : freezeEnd + Math.round(pertQuantile(ud, book.exitNotice[cell.contract]))
      if (e >= wave) { dep = wave; kind = 'transfer' } else { dep = e; kind = 'exit' }
    } else {
      const r = freezeEnd + Math.round(pertQuantile(ud, book.replatformOffset))
      dep = Math.min(r, wave)
      kind = 'replatform'
    }
    implied[kind] += 1 / K
    if (dep >= 0 && dep < W) {
      if (kind === 'transfer') transferLeaving[dep] += 1 / K
      else if (kind === 'exit') exitLeaving[dep] += 1 / K
      else replatformLeaving[dep] += 1 / K
    }
  }
  let left = 1
  for (let w = 0; w < W; w++) {
    left -= transferLeaving[w] + exitLeaving[w] + replatformLeaving[w]
    remaining[w] = Math.max(0, left)
  }
  const total = implied.transfer + implied.exit + implied.replatform || 1
  return {
    remaining, transferLeaving, exitLeaving, replatformLeaving,
    impliedFates: { transfer: implied.transfer / total, exit: implied.exit / total, replatform: implied.replatform / total },
    transferShareAtAnnouncement: tauOf(remaining, transferLeaving, freezeEnd, W),
  }
}

/** PERT quantile by bisection on the Beta CDF (used by the sampler so one uniform decides a departure). */
export function pertQuantile(u: number, t: Triple): number {
  const [lo, , hi] = t
  if (!(hi > lo)) return lo
  let a = 0
  let b = 1
  for (let i = 0; i < 50; i++) {
    const m = (a + b) / 2
    if (pertCdf(lo + m * (hi - lo), t) < u) a = m
    else b = m
  }
  return lo + ((a + b) / 2) * (hi - lo)
}

/**
 * Staff moves implied by a curve. Only the staff of transferring work move: at the announcement a
 * share τ of the team is destined to transfer; each wave takes its share of that group. As a share
 * of the whole current team (one stock, no releases): pct_w = τ·t_w/T_a ÷ (τ·T_w/T_a + 1 − τ), where
 * T_a is the transferring work still here at the announcement and T_w the part not yet moved.
 * So the staff of exited or re-platformed clients stay (to be released, or idle) instead of being
 * shipped with the next wave, and the split reproduces the single stock exactly.
 */
export function staffWavesFrom(curve: BookCurve): { week: number; pct: number; pctOfTransferGroup: number }[] {
  const out: { week: number; pct: number; pctOfTransferGroup: number }[] = []
  const W = curve.remaining.length
  const tau = curve.transferShareAtAnnouncement
  let transferAhead = curve.transferLeaving.reduce((s, x) => s + x, 0)
  const transferAtAnnouncement = transferAhead
  for (let w = 0; w < W; w++) {
    const t = curve.transferLeaving[w]
    if (t > 1e-12) {
      const ofGroup = Math.min(1, t / Math.max(transferAhead, 1e-12))
      const groupShare = tau * (transferAhead / Math.max(transferAtAnnouncement, 1e-12)) // transfer group ÷ team, before this move
      const pct = groupShare + (1 - tau) > 1e-12 ? Math.min(1, (groupShare * ofGroup) / (groupShare + (1 - tau))) : 0
      out.push({ week: w, pct, pctOfTransferGroup: ofGroup })
    }
    transferAhead -= t
  }
  return out
}

/** Share of the work leaving at week w for any reason, relative to what was still here: the backlog leaves with it. */
export function departingShare(curve: BookCurve, w: number): number {
  const before = w === 0 ? 1 : curve.remaining[w - 1]
  const gone = curve.transferLeaving[w] + curve.exitLeaving[w] + curve.replatformLeaving[w]
  return before > 1e-12 ? Math.min(1, gone / before) : 0
}
