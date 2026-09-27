// Weekly simulation of a pool whose demand and supply both leave.
//
// Two passes per run. The demand pass depends only on the demand inputs and the freeze end:
// volumes per channel, offered load per intraday bucket, and the agents each channel needs to
// reach its target. The supply pass walks the weeks in a fixed order (waves, attrition,
// backfill, releases, productive hours) and allocates the pool by priority:
// voice, then chat, then email from whatever is left, with spare hours returned to voice
// and chat. Shrinkage is applied once, on the supply side.

import { bookWaves, departingShare, expectedBook, staffWavesFrom } from './book'
import { curve } from './erlang'
import { curveA } from './erlangA'
import { binomial, type Rng } from './random'
import type { Balance, BookCurve, Channel, Inputs, ServiceModel, InteractiveWeek, Phase, RunResult, WeekResult, WeekTrace } from './types'

const INTERVAL = 1800 // seconds per Erlang interval
const SLIVER = 0.1 // channels below this share of baseline volume are not scored
const EPS = 1e-6

/** Anything that can say what service a number of agents gives (Erlang C or Erlang A). */
interface ServiceCurve {
  readonly a: number
  sl(n: number): number
  need(target: number): number
  abandon(n: number): number
}

interface BucketNeed {
  v: ServiceCurve // Erlang C, used for sizing (required FTE)
  c: ServiceCurve
  needV: number // agents needed at target under Erlang C (sizing)
  needC: number
  sv: ServiceCurve // the service model's curve (Erlang A or the same Erlang C curve)
  sc: ServiceCurve
  sNeedV: number // agents needed at target under the service model (staffing and allocation)
  sNeedC: number
}

interface DemandWeek {
  vol: { voice: number; chat: number; email: number }
  buckets: BucketNeed[]
  interactiveNeedHours: number // Σ_b (needV + needC) × hours_b
  bucketBindHours: number // max_b need hours_b / alloc_b
  emailArrivalHours: number
  fteReqNoBacklog: number
}

export interface RunOptions {
  rng?: Rng // present: attrition is drawn (Monte Carlo); absent: expected values
  traceWeek?: number // record every intermediate for this week in RunResult.trace
  freezeEndOverride?: number
  overrides?: Partial<{ tensionMult: number; postMult: number; surgePts: number; runoffPctWeek: number }>
  quantiseLoad?: boolean // Monte Carlo: round offered loads to 3 significant figures so Erlang curves are reused
  bookCurve?: BookCurve // book mode, Monte Carlo: one future's drawn departure staircase (default: the expected curve)
}

/** A staff move: a share of the whole team leaves (pct), which is a share pctT of the transfer group when the team is split. */
export interface StaffWave { week: number; pct: number; pctT: number }

/** Manual waves with, for each, the share of the transfer group it takes: π_j ÷ τ_j, τ_j = 1 − Π_{k≥j}(1 − π_k). */
export function staffWaves(inp: Inputs, freezeEnd: number): StaffWave[] {
  const ws = scheduledWaves(inp, freezeEnd)
  const out: StaffWave[] = []
  for (let j = 0; j < ws.length; j++) {
    let keep = 1
    for (let k = j; k < ws.length; k++) keep *= 1 - ws[k].pct
    const tau = 1 - keep
    out.push({ week: ws[j].week, pct: ws[j].pct, pctT: tau > 1e-12 ? Math.min(1, ws[j].pct / tau) : 0 })
  }
  return out
}

export function allocShares(inp: Inputs): number[] {
  const { volumeShare: vs, hourShare: hs, scheduleFit: fit } = inp.profile
  return vs.map((v, b) => fit * v + (1 - fit) * hs[b])
}

export function waveWeeks(inp: Inputs, freezeEnd: number): number[] {
  return inp.after.waves.map((w) => freezeEnd + Math.max(0, Math.round(w.weeksAfterFreeze)))
}

/** Waves are entered as shares of the book (30% + 30% + 40% = fully migrated). Each is
 *  applied as a share of what remains when it cuts over, so the last one takes the rest.
 *  Waves are applied in time order; shares beyond 100% in total are capped. */
export function scheduledWaves(inp: Inputs, freezeEnd: number): { week: number; pct: number }[] {
  const weeks = waveWeeks(inp, freezeEnd)
  const order = inp.after.waves.map((w, i) => ({ week: weeks[i], share: Math.max(0, w.pct) })).sort((x, y) => x.week - y.week)
  let taken = 0
  return order.map(({ week, share }) => {
    const s = Math.min(share, 1 - taken)
    const pct = 1 - taken > 1e-12 ? s / (1 - taken) : 0
    taken += s
    return { week, pct: Math.min(1, pct) }
  })
}

/** Loads, curves and agents needed for one week's volumes (also used when retries add volume). */
const sig3 = (x: number) => (x > 0 ? Number(x.toPrecision(3)) : x)

export function demandWeekFor(inp: Inputs, vol: { voice: number; chat: number; email: number }, quantise = false): DemandWeek {
  const { voice, chat, email } = inp.channels
  const { openHours, paidHours, shrinkage } = inp.pool
  const vs = inp.profile.volumeShare
  const alloc = allocShares(inp)
  const hours = inp.profile.hourShare.map((h) => openHours * h)
  const svc: ServiceModel = inp.service ?? { model: 'C', patience: { voice: 120, chat: 300 }, redialRate: 0, abandonCap: 1 }
  const useA = svc.model === 'A'
  let interactiveNeedHours = 0
  let bucketBind = 0
  const buckets: BucketNeed[] = vs.map((share, b) => {
    const intervals = (hours[b] * 3600) / INTERVAL
    const aV = intervals > 0 ? ((vol.voice * share) / intervals) * (voice.aht / INTERVAL) : 0
    const ahtC = chat.aht / Math.max(chat.concurrency, 1)
    const aC = intervals > 0 ? ((vol.chat * share) / intervals) * (ahtC / INTERVAL) : 0
    const qV = quantise ? sig3(aV) : aV
    const qC = quantise ? sig3(aC) : aC
    const v = curve(qV, voice.slSeconds / voice.aht)
    const c = curve(qC, chat.slSeconds / ahtC)
    const needV = v.need(voice.slTarget)
    const needC = c.need(chat.slTarget)
    const needHours = (needV + needC) * hours[b]
    interactiveNeedHours += needHours
    if (alloc[b] > 0) bucketBind = Math.max(bucketBind, needHours / alloc[b])
    const sv: ServiceCurve = useA ? curveA(qV, voice.aht / Math.max(1, svc.patience.voice), voice.slSeconds / voice.aht) : v
    const sc: ServiceCurve = useA ? curveA(qC, ahtC / Math.max(1, svc.patience.chat), chat.slSeconds / ahtC) : c
    return { v, c, needV, needC, sv, sc, sNeedV: useA ? sv.need(voice.slTarget) : needV, sNeedC: useA ? sc.need(chat.slTarget) : needC }
  })
  const emailArrivalHours = (vol.email * email.aht) / 3600
  const hReq = Math.max(bucketBind, interactiveNeedHours + emailArrivalHours)
  return {
    vol,
    buckets,
    interactiveNeedHours,
    bucketBindHours: bucketBind,
    emailArrivalHours,
    fteReqNoBacklog: hReq / (paidHours * (1 - shrinkage)),
  }
}

function demandPass(inp: Inputs, freezeStart: number, freezeEnd: number, runoff: number, quantise = false, book?: BookCurve): DemandWeek[] {
  const W = inp.horizonWeeks
  const { voice, chat, email } = inp.channels
  const runoffStart = inp.demand.runoffStartWeek ?? freezeStart
  const waves = scheduledWaves(inp, freezeEnd)

  const out: DemandWeek[] = []
  let existing = 1
  let waveMult = 1
  let cumExit = 0 // book mode: work that left without transferring (exits + re-platforming), share of the week-0 book
  for (let w = 0; w < W; w++) {
    let f: number
    if (book) {
      // book mode: the departure curve replaces runoff, step-downs and waves. Intake replaces only the
      // work that exited or re-platformed (never transferred work), scaled like manual mode by the
      // share of the non-exited book that has not yet transferred
      cumExit += book.exitLeaving[w] + book.replatformLeaving[w]
      const left = book.remaining[w]
      const notTransferred = left / Math.max(1e-12, 1 - cumExit)
      f = left + (inp.demand.intakeOn ? inp.demand.intakePct * cumExit * Math.min(1, notTransferred) : 0)
    } else {
      if (w >= runoffStart) existing *= 1 - runoff
      for (const s of inp.demand.stepDowns) if (s.week === w) existing *= 1 - s.pct
      for (const wv of waves) if (wv.week === w) waveMult *= 1 - wv.pct
      const newBook = inp.demand.intakeOn ? inp.demand.intakePct * (1 - existing) : 0
      f = (existing + newBook) * waveMult
    }
    const vol = { voice: voice.volume * f, chat: chat.volume * f, email: email.volume * f }
    out.push(demandWeekFor(inp, vol, quantise))
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Channel balancing. Capacity is held per intraday bucket as agents (hours ÷ bucket hours), in two
// pools: the team's own staff and borrowed staff (usable only on eligible channels, and used first
// on them). Interactive channels are staffed bucket by bucket; email is deferrable and draws the
// same share from every bucket's email-usable capacity. Each policy sets targets, the targets are
// filled, email is topped up to its full due, and spare time returns to voice and chat.
// Strict priority voice → chat → email reproduces the pre-balancing engine exactly.

const DEFAULT_ORDER: Channel[] = ['voice', 'chat', 'email']

export function normaliseBalance(b: Partial<Balance> | undefined): Balance {
  const order = Array.isArray(b?.order) && b!.order.length === 3 && new Set(b!.order).size === 3 && b!.order.every((c) => DEFAULT_ORDER.includes(c)) ? b!.order : DEFAULT_ORDER
  const mode = b?.mode && ['priority', 'floor', 'prorata', 'equal'].includes(b.mode) ? b.mode : 'priority'
  const f = Number(b?.emailFloor)
  return { mode, order, emailFloor: Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0.9 }
}

interface Pools {
  inAg: number[]
  borAg: number[]
}

interface AllocArgs {
  inp: Inputs
  balance: Balance
  hours: number[]
  alloc: number[]
  d: DemandWeek
  P: number
  Bhome: number
  due: number // email backlog carried in + this week's arrivals, hours
  dailyArr: number
  scored: { voice: boolean; chat: boolean; email: boolean }
}

export interface Allocation {
  nV: number[]
  nC: number[]
  nVBefore: number[]
  nCBefore: number[]
  tV: number[]
  tC: number[]
  worked: number
  workedBeforeTopUp: number
  emailCap: number
  emailNeed: number
  emailTarget: number
  floorHours: number
  borIdle: number
  inIdle: number
  ratio: number | null
  attainment: number | null
  fellBack: boolean
  iterations: number
  borrowedByChannel: { voice: number; chat: number; email: number }
}

const clonePools = (p: Pools): Pools => ({ inAg: [...p.inAg], borAg: [...p.borAg] })

/** Borrowed first if eligible, then the team's own staff; returns agents given (≤ need). */
function takeInteractive(pools: Pools, k: number, need: number, eligible: boolean): { given: number; fromBorrowed: number } {
  const fromB = eligible ? Math.min(pools.borAg[k], need) : 0
  pools.borAg[k] -= fromB
  const fromI = Math.min(pools.inAg[k], need - fromB)
  pools.inAg[k] -= fromI
  return { given: fromB + fromI, fromBorrowed: fromB }
}

/**
 * Email takes borrowed time first (if eligible), then the team's own; within each pool it takes
 * the same share of every bucket's remaining capacity. Returns hours worked.
 */
function drawEmail(pools: Pools, hours: number[], x: number, eligE: boolean): { worked: number; cap: number; fromBorrowed: number } {
  const inH = pools.inAg.reduce((s, a, k) => s + a * hours[k], 0)
  const borH = eligE ? pools.borAg.reduce((s, a, k) => s + a * hours[k], 0) : 0
  const cap = inH + borH
  const worked = Math.min(cap, x)
  const fromBorrowed = Math.min(borH, worked)
  const fromIn = worked - fromBorrowed
  const shareB = borH > 0 ? fromBorrowed / borH : 0
  const shareI = inH > 0 ? fromIn / inH : 0
  for (let k = 0; k < pools.inAg.length; k++) {
    pools.inAg[k] = pools.inAg[k] * (1 - shareI)
    if (eligE) pools.borAg[k] = pools.borAg[k] * (1 - shareB)
  }
  return { worked, cap, fromBorrowed }
}

function allocate(a: AllocArgs): Allocation {
  const { inp, balance, hours, alloc, d, P, Bhome, due, dailyArr, scored } = a
  const el = inp.borrowed.eligible
  const pools: Pools = {
    inAg: hours.map((h, k) => (h > 0 ? (P * alloc[k]) / h : 0)),
    borAg: hours.map((h, k) => (h > 0 ? (Bhome * alloc[k]) / h : 0)),
  }
  // staffing follows the service model (Erlang A when chosen); sizing elsewhere stays Erlang C
  const needV = d.buckets.map((b) => b.sNeedV)
  const needC = d.buckets.map((b) => b.sNeedC)
  const targetDays = inp.channels.email.targetDays
  // email's need this week: its arrivals plus a quarter of any backlog beyond target (as in required FTE)
  const emailNeed = d.emailArrivalHours + Math.max(0, due - d.emailArrivalHours - targetDays * dailyArr) / 4
  const nV = [0, 0, 0]
  const nC = [0, 0, 0]
  const bor = { voice: 0, chat: 0, email: 0 }
  let worked = 0
  let emailCap = NaN
  let floorHours = 0
  let emailTarget = due
  let ratio: number | null = null
  let attainment: number | null = null
  let fellBack = false
  let iterations = 0

  const staff = (ch: 'voice' | 'chat', targets: number[], p: Pools = pools, record = true) => {
    let ok = true
    for (let k = 0; k < 3; k++) {
      const r = takeInteractive(p, k, targets[k], el[ch])
      if (record) {
        ;(ch === 'voice' ? nV : nC)[k] = r.given
        bor[ch] += r.fromBorrowed * hours[k]
      }
      if (r.given < targets[k] - 1e-9) ok = false
    }
    return ok
  }
  const email = (x: number, p: Pools = pools, record = true) => {
    const r = drawEmail(p, hours, x, el.email)
    if (record) {
      worked += r.worked
      bor.email += r.fromBorrowed
      if (Number.isNaN(emailCap)) emailCap = r.cap
    }
    return r.worked >= x - 1e-9
  }
  /** Can these targets all be met (fill voice, chat per bucket, then email)? */
  const feasible = (tV: number[], tC: number[], tE: number) => {
    const p = clonePools(pools)
    return staff('voice', tV, p, false) && staff('chat', tC, p, false) && email(tE, p, false)
  }
  /** Largest s in [0, 1] for which targets(s) are feasible (targets must grow with s). */
  const bisect = (targets: (s: number) => [number[], number[], number]) => {
    if (feasible(...targets(1))) return 1
    let lo = 0
    let hi = 1
    for (iterations = 0; iterations < 40 && hi - lo > 1e-6; iterations++) {
      const mid = (lo + hi) / 2
      if (feasible(...targets(mid))) lo = mid
      else hi = mid
    }
    return lo
  }

  let tV = needV
  let tC = needC
  if (balance.mode === 'priority') {
    const emailLast = balance.order[2] === 'email'
    for (const ch of balance.order) {
      if (ch === 'email') {
        emailTarget = emailLast ? due : Math.min(due, emailNeed)
        email(emailTarget)
      } else staff(ch, ch === 'voice' ? needV : needC)
    }
  } else if (balance.mode === 'floor') {
    floorHours = Math.min(due, balance.emailFloor * d.emailArrivalHours)
    email(floorHours)
    floorHours = worked
    for (const ch of balance.order) if (ch !== 'email') staff(ch, ch === 'voice' ? needV : needC)
    emailTarget = due
  } else {
    const prorata = (s: number): [number[], number[], number] => [needV.map((x) => s * x), needC.map((x) => s * x), s * Math.min(due, emailNeed)]
    let targets = prorata
    if (balance.mode === 'equal') {
      const tVoice = inp.channels.voice.slTarget
      const tChat = inp.channels.chat.slTarget
      const equal = (s: number): [number[], number[], number] => [
        d.buckets.map((b, k) => (scored.voice ? b.sv.need(s * tVoice) : needV[k])),
        d.buckets.map((b, k) => (scored.chat ? b.sc.need(s * tChat) : needC[k])),
        scored.email ? (s > 0 ? Math.max(0, due - (targetDays * dailyArr) / s) : 0) : Math.min(due, emailNeed),
      ]
      if (feasible(...equal(0))) {
        targets = equal
        attainment = bisect(equal)
      } else fellBack = true
    }
    if (balance.mode === 'prorata' || fellBack) ratio = bisect(prorata)
    const [a1, a2, a3] = targets(attainment ?? ratio ?? 1)
    tV = a1
    tC = a2
    emailTarget = a3
    staff('voice', tV)
    staff('chat', tC)
    email(emailTarget)
  }
  const nVBefore = [...nV]
  const nCBefore = [...nC]
  const workedBeforeTopUp = worked
  // email is worked down to its full due with whatever is left
  if (!(balance.mode === 'priority' && balance.order[2] === 'email') && due - worked > 1e-12) email(due - worked)

  // spare time goes back to voice and chat in proportion to need
  let borIdle = 0
  let inIdle = 0
  for (let k = 0; k < 3; k++) {
    const spareIn = pools.inAg[k]
    const spareBor = pools.borAg[k]
    const nv = needV[k]
    const nc = needC[k]
    const tot = nv + nc
    if (tot > 0) {
      nV[k] += (spareIn * nv) / tot
      nC[k] += (spareIn * nc) / tot
      const eligV = el.voice && nv > 0
      const eligC = el.chat && nc > 0
      const eTot = (eligV ? nv : 0) + (eligC ? nc : 0)
      if (eTot > 0) {
        if (eligV) nV[k] += (spareBor * nv) / eTot
        if (eligC) nC[k] += (spareBor * nc) / eTot
      } else borIdle += spareBor * hours[k]
    } else {
      borIdle += spareBor * hours[k]
      inIdle += spareIn * hours[k]
    }
  }
  return {
    nV, nC, nVBefore, nCBefore, tV, tC, worked, workedBeforeTopUp, emailCap: Number.isNaN(emailCap) ? 0 : emailCap,
    emailNeed, emailTarget, floorHours, borIdle, inIdle, ratio, attainment, fellBack, iterations, borrowedByChannel: bor,
  }
}

function phaseOf(w: number, start: number, end: number): Phase {
  return w < start ? 'pre' : w < end ? 'freeze' : 'post'
}

export function run(inp: Inputs, opts: RunOptions = {}): RunResult {
  const W = inp.horizonWeeks
  const o = opts.overrides ?? {}
  const tension = o.tensionMult ?? inp.attrition.tensionMult
  const post = o.postMult ?? inp.attrition.postMult
  const surgePts = o.surgePts ?? inp.after.surgePts
  const runoff = o.runoffPctWeek ?? inp.demand.runoffPctWeek
  const freezeStart = Math.max(0, Math.round(inp.freeze.startWeek))
  const freezeEnd = Math.max(freezeStart, Math.round(opts.freezeEndOverride ?? inp.freeze.endWeek))
  const warnings: string[] = []

  const q = !!opts.quantiseLoad
  const bookMode = inp.book?.mode === 'book'
  const bookCurve = bookMode ? opts.bookCurve ?? expectedBook(inp, freezeEnd) : undefined
  const demand = demandPass(inp, freezeStart, freezeEnd, runoff, q, bookCurve)
  const base = demandPass({ ...inp, demand: { ...inp.demand, runoffPctWeek: 0, stepDowns: [], intakeOn: false }, after: { ...inp.after, waves: [] } }, freezeStart, freezeEnd, 0, q)[0]
  // staff moves: manual waves (conditional shares of the book), or derived from the book's transfers
  const waves: StaffWave[] = bookCurve
    ? staffWavesFrom(bookCurve).map((x) => ({ week: x.week, pct: x.pct, pctT: x.pctOfTransferGroup }))
    : staffWaves(inp, freezeEnd)
  if (!bookMode && waves.some((wv) => wv.week >= W)) warnings.push('One or more waves fall beyond the horizon; their training still counts but the move does not happen.')
  const slipLikely = bookMode ? Math.round(inp.book.waveSlip[1]) : 0
  if (bookMode && bookWaves(inp.book).some((x) => freezeEnd + x.offset + slipLikely >= W)) warnings.push('One or more book waves (with the likely slip) fall beyond the horizon: that work and its staff never leave within the horizon.')
  if (bookCurve && bookCurve.impliedFates.transfer > 0 && bookCurve.transferShareAtAnnouncement < bookCurve.impliedFates.transfer - 0.02) warnings.push('Part of the transferring work leaves after the horizon, so the transfer group at the announcement is smaller than the book\'s transfer share.')
  const split = inp.people?.split === true
  const ppl = inp.people ?? { split: false, postMultTransfer: post, postMultRelease: post, retentionEffect: 0, retentionTarget: 'release' as const }
  const retT = ppl.retentionTarget === 'transfer' || ppl.retentionTarget === 'both' ? ppl.retentionEffect : 0
  const retR = ppl.retentionTarget === 'release' || ppl.retentionTarget === 'both' ? ppl.retentionEffect : 0
  if (freezeStart === 0 && inp.freeze.backfillBefore) warnings.push('The freeze starts in week 0, so pre-freeze backfill never applies.')

  const { paidHours, shrinkage, openHours } = inp.pool
  const balance = normaliseBalance(inp.balance)
  const alloc = allocShares(inp)
  const hours = inp.profile.hourShare.map((h) => openHours * h)
  const H0 = inp.pool.fte
  let H = H0
  let T = 0 // transfer group (people.split, after the announcement)
  let R = 0 // release group
  let splitDone = false
  let tauAtSplit = NaN
  const flows: RunResult['flows'] = { start: H0, hired: 0, attritionPre: 0, attritionFreeze: 0, attritionPost: 0, moved: 0, released: 0, end: 0 }
  if (split) { flows.attritionPostTransfer = 0; flows.attritionPostRelease = 0 }
  let backlog = 0
  let backlogMoved = 0
  const weeks: WeekResult[] = []
  let trace: WeekTrace | undefined

  const svc = inp.service ?? { model: 'C' as const, patience: { voice: 120, chat: 300 }, redialRate: 0, abandonCap: 1 }
  const useA = svc.model === 'A'
  // Forecast volumes already contain today's redials, so only abandonment above the week-0 rate
  // creates extra contacts. They arrive the following week, in proportion to the book still here.
  let retries = { voice: 0, chat: 0 }
  let baseAbandon: { voice: number; chat: number } | null = null

  for (let w = 0; w < W; w++) {
    const stay = (key: 'voice' | 'chat') => (w > 0 && demand[w - 1].vol[key] > 0 ? Math.min(1, demand[w].vol[key] / demand[w - 1].vol[key]) : 0)
    const retriesIn = { voice: retries.voice * stay('voice'), chat: retries.chat * stay('chat') }
    // earlier abandoners who redial add to this week's volume (never under Erlang C: nobody abandons)
    const d = retriesIn.voice > 0 || retriesIn.chat > 0
      ? demandWeekFor(inp, { voice: demand[w].vol.voice + retriesIn.voice, chat: demand[w].vol.chat + retriesIn.chat, email: demand[w].vol.email }, q)
      : demand[w]
    const phase = phaseOf(w, freezeStart, freezeEnd)
    const headsAtStart = H
    const backlogIn = backlog

    // 0. the announcement: the team splits into those who go with the work and those who stay to be released
    if (split && !splitDone && w >= freezeEnd) {
      let tau: number
      if (bookCurve) tau = bookCurve.transferShareAtAnnouncement
      else {
        let keep = 1
        for (const wv of waves) if (wv.week >= w) keep *= 1 - wv.pct
        tau = 1 - keep
      }
      tauAtSplit = Math.min(1, Math.max(0, tau))
      T = H * tauAtSplit
      R = H - T
      splitDone = true
    }

    // 1. waves: staff and the work's email backlog leave with it, in sequence when they share a week
    //    (book mode: the backlog leaves with every departure, transfers, exits and re-platforming alike)
    let moved = 0
    for (const wv of waves)
      if (wv.week === w) {
        if (splitDone) {
          const m = T * wv.pctT
          T -= m
          H = T + R
          moved += m
        } else {
          const m = H * wv.pct
          H -= m
          moved += m
        }
        if (!bookCurve) {
          backlogMoved += backlog * wv.pct
          backlog *= 1 - wv.pct
        }
      }
    if (bookCurve) {
      const sh = departingShare(bookCurve, w)
      backlogMoved += backlog * sh
      backlog *= 1 - sh
    }

    // 2. attrition
    const mult = phase === 'pre' ? 1 : phase === 'freeze' ? tension : post
    const p = Math.min(1, (inp.attrition.annual / 52) * mult)
    let lost: number
    let lostT = 0
    let lostR = 0
    let pT = NaN
    let pR = NaN
    if (splitDone) {
      pT = Math.min(1, (inp.attrition.annual / 52) * ppl.postMultTransfer * (1 - retT))
      pR = Math.min(1, (inp.attrition.annual / 52) * ppl.postMultRelease * (1 - retR))
      lostT = opts.rng ? Math.min(T, binomial(opts.rng, Math.round(T), pT)) : T * pT
      lostR = opts.rng ? Math.min(R, binomial(opts.rng, Math.round(R), pR)) : R * pR
      T -= lostT
      R -= lostR
      lost = lostT + lostR
      H = T + R
    } else {
      lost = opts.rng ? Math.min(H, binomial(opts.rng, Math.round(H), p)) : H * p
      H -= lost
    }

    // 3. backfill, before the freeze only
    const hired = phase === 'pre' && inp.freeze.backfillBefore ? Math.max(0, H0 - H) : 0
    H += hired

    // this week's productive hours per head: shrinkage plus the absence surge, less pre-wave training
    // (after the split, training falls on the transfer group only)
    const surge = phase === 'post' && w < freezeEnd + inp.after.surgeWeeks ? surgePts : 0
    let trainPerHead = 0
    for (const wv of waves)
      if (inp.after.trainingWeeks > 0 && w >= wv.week - inp.after.trainingWeeks && w < wv.week)
        trainPerHead += ((splitDone ? wv.pctT : wv.pct) * inp.after.trainingHours) / inp.after.trainingWeeks
    const grossPerHead = paidHours * (1 - Math.min(0.95, shrinkage + surge))
    const prodPerHead = Math.max(1e-9, grossPerHead - trainPerHead)

    // 4. releases, only after the dismissal notice and never below the look-ahead need: the largest
    //    required hours over this and the next lookahead weeks, including this week's retries and
    //    the email backlog carried in, converted to heads at this week's productive hours per head
    //    (after the split, only the release group is released)
    let released = 0
    if (inp.after.releasesOn && w >= freezeEnd + inp.after.noticeWeeks) {
      let needHours = 0
      for (let k = w + 1; k <= Math.min(W - 1, w + inp.after.lookaheadWeeks); k++) needHours = Math.max(needHours, demand[k].fteReqNoBacklog * paidHours * (1 - shrinkage))
      const dailyNow = (d.emailArrivalHours > 0 ? d.emailArrivalHours : base.emailArrivalHours) / 5
      const excessNow = Math.max(0, backlog - inp.channels.email.targetDays * dailyNow)
      needHours = Math.max(needHours, d.bucketBindHours, d.interactiveNeedHours + d.emailArrivalHours + excessNow / 4)
      if (splitDone) {
        // the week's productive hours as step 5 will compute them: everyone's gross hours less the
        // transfer group's training (which can exceed its own hours and eat into the release group's)
        let trainingT = 0
        for (const wv of waves)
          if (inp.after.trainingWeeks > 0 && w >= wv.week - inp.after.trainingWeeks && w < wv.week) trainingT += (T * wv.pctT * inp.after.trainingHours) / inp.after.trainingWeeks
        const capacity = (T + R) * grossPerHead - trainingT
        released = Math.max(0, Math.min(R, (capacity - (1 + inp.after.releaseBuffer) * needHours) / grossPerHead))
        R -= released
        H = T + R
      } else {
        released = Math.max(0, H - ((1 + inp.after.releaseBuffer) * needHours) / prodPerHead)
        H -= released
      }
    }

    // 5. productive hours
    let trainingHours = 0
    for (const wv of waves)
      if (inp.after.trainingWeeks > 0 && w >= wv.week - inp.after.trainingWeeks && w < wv.week)
        trainingHours += ((splitDone ? T * wv.pctT : H * wv.pct) * inp.after.trainingHours) / inp.after.trainingWeeks
    const P = Math.max(0, H * paidHours * (1 - Math.min(0.95, shrinkage + surge)) - trainingHours)
    const b = inp.borrowed
    const borrowActive = w >= b.startWeek && w <= b.endWeek && b.fte > 0
    const Bhome = borrowActive ? (b.fte * paidHours * (1 - shrinkage)) / Math.max(1, b.ahtPenalty) : 0

    // share the week's capacity between channels according to the balancing policy
    const dailyArr = (d.emailArrivalHours > 0 ? d.emailArrivalHours : base.emailArrivalHours) / 5
    const due = backlog + d.emailArrivalHours
    const A = allocate({
      inp, balance, hours, alloc, d, P, Bhome, due, dailyArr,
      scored: {
        voice: d.vol.voice >= SLIVER * base.vol.voice && base.vol.voice > 0,
        chat: d.vol.chat >= SLIVER * base.vol.chat && base.vol.chat > 0,
        email: d.vol.email >= SLIVER * base.vol.email && base.vol.email > 0,
      },
    })
    const { nV, nC, nVBefore, nCBefore, worked, emailCap, borIdle, inIdle } = A
    backlog = due - worked
    const borrowedUsedHours = Math.max(0, Bhome - borIdle)

    const vs = inp.profile.volumeShare
    const interactive = (key: 'voice' | 'chat', ns: number[]): InteractiveWeek => {
      const volume = d.vol[key]
      const scored = volume >= SLIVER * base.vol[key] && base.vol[key] > 0
      let sl = 0
      let ab = 0
      let unstable = false
      let need = 0
      let given = 0
      for (let k = 0; k < 3; k++) {
        const bk = d.buckets[k]
        const cv = key === 'voice' ? bk.sv : bk.sc
        const n = ns[k]
        if (!useA && cv.a > 0 && n <= cv.a) unstable = true // an Erlang C queue with no spare agents never clears
        sl += vs[k] * cv.sl(n)
        if (useA) ab += vs[k] * cv.abandon(n)
        need += (key === 'voice' ? bk.needV : bk.needC) * hours[k]
        given += n * hours[k]
      }
      return {
        volume, scored, sl: scored ? sl : NaN, need, given, unstable: scored && unstable,
        abandonRate: scored ? ab : NaN, abandoned: volume * ab, retriesIn: retriesIn[key],
      }
    }
    const voice = interactive('voice', nV)
    const chat = interactive('chat', nC)
    baseAbandon ??= { voice: voice.abandonRate || 0, chat: chat.abandonRate || 0 }
    const extra = (x: InteractiveWeek, r0: number) => Math.max(0, x.abandoned - r0 * x.volume) * svc.redialRate
    retries = { voice: extra(voice, baseAbandon.voice), chat: extra(chat, baseAbandon.chat) }

    const emailScored = d.vol.email >= SLIVER * base.vol.email && base.vol.email > 0
    const backlogDays = dailyArr > 0 ? backlog / dailyArr : 0
    const targetDays = inp.channels.email.targetDays
    const timeliness = backlogDays <= targetDays ? 1 : targetDays / backlogDays
    const email = {
      volume: d.vol.email,
      scored: emailScored,
      arrivalHours: d.emailArrivalHours,
      workedHours: worked,
      backlogHours: backlog,
      backlogDays,
      timeliness: emailScored ? timeliness : NaN,
    }

    const excess = Math.max(0, backlog - targetDays * dailyArr)
    const hReq = Math.max(d.bucketBindHours, d.interactiveNeedHours + d.emailArrivalHours + excess / 4)
    const fteReq = hReq / (paidHours * (1 - shrinkage))
    const fteAvail = (P + borrowedUsedHours) / (paidHours * (1 - shrinkage))
    const offered = d.interactiveNeedHours + d.emailArrivalHours
    const utilisation = P + borrowedUsedHours > 0 ? offered / (P + borrowedUsedHours) : offered > 0 ? Infinity : 0

    const meets = (x: InteractiveWeek, t: number) => !x.scored || x.sl >= t - EPS
    const meetsAll =
      meets(voice, inp.channels.voice.slTarget) && meets(chat, inp.channels.chat.slTarget) && (!emailScored || timeliness >= 1 - EPS)
    const attain = [
      voice.scored ? voice.sl / inp.channels.voice.slTarget : Infinity,
      chat.scored ? chat.sl / inp.channels.chat.slTarget : Infinity,
      emailScored ? timeliness : Infinity,
    ]
    const worst = Math.min(...attain)
    const cover = fteReq > 0 ? fteAvail / fteReq : 1
    const clamp = (x: number) => Math.min(1, Math.max(0, x))
    const anyScored = voice.scored || chat.scored || emailScored
    const worstAbandon = Math.max(voice.scored ? voice.abandonRate : 0, chat.scored ? chat.abandonRate : 0)
    const scoreBeforeCap = !anyScored
      ? NaN // nothing left to serve: migration complete
      :
      (voice.unstable && voice.scored) || (chat.unstable && chat.scored)
        ? 0.05
        : meetsAll
          ? 0.7 + 0.3 * clamp((cover - 1) / 0.1)
          : 0.7 * clamp((Math.min(worst, 1) - 0.5) / 0.5)
    // under Erlang A, heavy abandonment caps the grade: above the cap at BBB, above twice it at CCC
    const score = !useA || !(worstAbandon > svc.abandonCap)
      ? scoreBeforeCap
      : Math.min(scoreBeforeCap, worstAbandon > 2 * svc.abandonCap ? 0.39 : 0.69)

    if (phase === 'pre') flows.attritionPre += lost
    else if (phase === 'freeze') flows.attritionFreeze += lost
    else flows.attritionPost += lost
    if (splitDone) {
      flows.attritionPostTransfer = (flows.attritionPostTransfer ?? 0) + lostT
      flows.attritionPostRelease = (flows.attritionPostRelease ?? 0) + lostR
    }
    flows.hired += hired
    flows.moved += moved
    flows.released += released

    if (opts.traceWeek === w) {
      const names = ['peak', 'shoulder', 'off-peak']
      trace = {
        week: w,
        phase,
        headcount: {
          start: headsAtStart, moved, attritionRate: p, attritionMultiplier: mult, lost, hired, released, end: H,
          ...(splitDone ? {
            transferGroup: T, releaseGroup: R, transferShareAtSplit: tauAtSplit,
            // after the split the single-stock rate above is not used: each group has its own
            transferRate: pT, releaseRate: pR, transferMultiplier: ppl.postMultTransfer, releaseMultiplier: ppl.postMultRelease,
            retentionEffect: { transfer: retT, release: retR }, lostTransfer: lostT, lostRelease: lostR,
          } : {}),
        },
        hours: {
          paidHoursPerHead: paidHours, shrinkage, surgePts: surge, effectiveShrinkage: Math.min(0.95, shrinkage + surge),
          grossProductive: H * paidHours * (1 - Math.min(0.95, shrinkage + surge)), trainingHours, productive: P,
        },
        borrowed: { active: borrowActive, fte: borrowActive ? b.fte : 0, ahtPenalty: b.ahtPenalty, homeEquivalentHours: Bhome, usedHours: borrowedUsedHours, idleHours: borIdle },
        buckets: [0, 1, 2].map((k) => ({
          name: names[k],
          volumeShare: inp.profile.volumeShare[k],
          hourShare: inp.profile.hourShare[k],
          allocShare: alloc[k],
          openHours: hours[k],
          voice: { offeredErlangs: d.buckets[k].v.a, needAgents: d.buckets[k].sNeedV, sizingNeedAgents: d.buckets[k].needV, targetAgents: A.tV[k], agentsBeforeSpare: nVBefore[k], agentsFinal: nV[k], serviceLevel: d.buckets[k].sv.sl(nV[k]), abandonRate: d.buckets[k].sv.abandon(nV[k]) },
          chat: { offeredErlangs: d.buckets[k].c.a, needAgents: d.buckets[k].sNeedC, sizingNeedAgents: d.buckets[k].needC, targetAgents: A.tC[k], agentsBeforeSpare: nCBefore[k], agentsFinal: nC[k], serviceLevel: d.buckets[k].sc.sl(nC[k]), abandonRate: d.buckets[k].sc.abandon(nC[k]) },
          inHouseAgentsAvailable: hours[k] > 0 ? (P * alloc[k]) / hours[k] : 0,
          borrowedAgentsAvailable: hours[k] > 0 ? (Bhome * alloc[k]) / hours[k] : 0,
        })),
        email: {
          arrivalHours: d.emailArrivalHours, backlogIn, need: A.emailNeed, floorHours: A.floorHours, targetHours: A.emailTarget,
          workedBeforeTopUp: A.workedBeforeTopUp, topUpHours: worked - A.workedBeforeTopUp, capacityHours: emailCap, workedHours: worked,
          backlogOut: backlog, dailyArrivalHours: dailyArr, backlogDays, targetDays, timeliness,
        },
        balance: {
          mode: balance.mode, order: balance.order, emailFloor: balance.emailFloor, ratio: A.ratio, attainment: A.attainment,
          fellBackToProrata: A.fellBack, iterations: A.iterations, borrowedHoursByChannel: A.borrowedByChannel, inHouseIdleHours: inIdle,
        },
        required: { bucketBindHours: d.bucketBindHours, interactiveNeedHours: d.interactiveNeedHours, emailArrivalHours: d.emailArrivalHours, excessBacklogHours: excess, requiredHours: hReq, fteRequired: fteReq, fteAvailable: fteAvail },
        service: {
          model: svc.model, patience: svc.patience, redialRate: svc.redialRate, retriesIn,
          abandoned: { voice: voice.abandoned, chat: chat.abandoned }, retriesOut: retries,
        },
        grade: {
          meetsAll, attainment: { voice: attain[0], chat: attain[1], email: attain[2] }, worstAttainment: worst, cover,
          unstable: (voice.unstable && voice.scored) || (chat.unstable && chat.scored),
          worstAbandonRate: worstAbandon, abandonCap: svc.abandonCap, scoreBeforeCap, score,
        },
      }
    }

    weeks.push({
      week: w,
      phase,
      heads: H,
      hired,
      attrition: lost,
      moved,
      released,
      trainingHours,
      surgePts: surge,
      prodHours: P,
      borrowedUsedHours,
      borrowedIdleHours: borIdle,
      inHouseIdleHours: inIdle,
      fteAvail,
      fteReq,
      utilisation,
      ...(splitDone ? { groups: { transfer: T, release: R } } : {}),
      voice,
      chat,
      email,
      meetsAll,
      cappedByAbandonment: score < scoreBeforeCap,
      score,
    })
  }
  flows.end = H
  const waveWeeksOut = bookMode ? bookWaves(inp.book).map((x) => freezeEnd + x.offset + slipLikely) : waves.map((x) => x.week)
  return { trace, weeks, flows, emailBacklogMovedHours: backlogMoved, freezeStart, freezeEnd, waveWeeks: waveWeeksOut, warnings, ...(bookCurve ? { book: bookCurve } : {}) }
}
