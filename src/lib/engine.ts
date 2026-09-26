// Weekly simulation of a pool whose demand and supply both leave.
//
// Two passes per run. The demand pass depends only on the demand inputs and the freeze end:
// volumes per channel, offered load per intraday bucket, and the agents each channel needs to
// reach its target. The supply pass walks the weeks in a fixed order (waves, attrition,
// backfill, releases, productive hours) and allocates the pool by priority:
// voice, then chat, then email from whatever is left, with spare hours returned to voice
// and chat. Shrinkage is applied once, on the supply side.

import { curve, type ErlangCurve } from './erlang'
import { binomial, type Rng } from './random'
import type { Inputs, InteractiveWeek, Phase, RunResult, WeekResult, WeekTrace } from './types'

const INTERVAL = 1800 // seconds per Erlang interval
const SLIVER = 0.1 // channels below this share of baseline volume are not scored
const EPS = 1e-6

interface BucketNeed {
  v: ErlangCurve
  c: ErlangCurve
  needV: number // agents in the bucket
  needC: number
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

function demandPass(inp: Inputs, freezeStart: number, freezeEnd: number, runoff: number): DemandWeek[] {
  const W = inp.horizonWeeks
  const { voice, chat, email } = inp.channels
  const { openHours, paidHours, shrinkage } = inp.pool
  const vs = inp.profile.volumeShare
  const hs = inp.profile.hourShare
  const alloc = allocShares(inp)
  const hours = hs.map((h) => openHours * h)
  const runoffStart = inp.demand.runoffStartWeek ?? freezeStart
  const waves = scheduledWaves(inp, freezeEnd)

  const out: DemandWeek[] = []
  let existing = 1
  let waveMult = 1
  for (let w = 0; w < W; w++) {
    if (w >= runoffStart) existing *= 1 - runoff
    for (const s of inp.demand.stepDowns) if (s.week === w) existing *= 1 - s.pct
    for (const wv of waves) if (wv.week === w) waveMult *= 1 - wv.pct
    const newBook = inp.demand.intakeOn ? inp.demand.intakePct * (1 - existing) : 0
    const f = (existing + newBook) * waveMult
    const vol = { voice: voice.volume * f, chat: chat.volume * f, email: email.volume * f }

    let interactiveNeedHours = 0
    let bucketBind = 0
    const buckets: BucketNeed[] = vs.map((share, b) => {
      const intervals = (hours[b] * 3600) / INTERVAL
      const aV = intervals > 0 ? ((vol.voice * share) / intervals) * (voice.aht / INTERVAL) : 0
      const ahtC = chat.aht / Math.max(chat.concurrency, 1)
      const aC = intervals > 0 ? ((vol.chat * share) / intervals) * (ahtC / INTERVAL) : 0
      const v = curve(aV, voice.slSeconds / voice.aht)
      const c = curve(aC, chat.slSeconds / ahtC)
      const needV = v.need(voice.slTarget)
      const needC = c.need(chat.slTarget)
      const needHours = (needV + needC) * hours[b]
      interactiveNeedHours += needHours
      if (alloc[b] > 0) bucketBind = Math.max(bucketBind, needHours / alloc[b])
      return { v, c, needV, needC }
    })
    const emailArrivalHours = (vol.email * email.aht) / 3600
    const hReq = Math.max(bucketBind, interactiveNeedHours + emailArrivalHours)
    out.push({
      vol,
      buckets,
      interactiveNeedHours,
      bucketBindHours: bucketBind,
      emailArrivalHours,
      fteReqNoBacklog: hReq / (paidHours * (1 - shrinkage)),
    })
  }
  return out
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

  const demand = demandPass(inp, freezeStart, freezeEnd, runoff)
  const base = demandPass({ ...inp, demand: { ...inp.demand, runoffPctWeek: 0, stepDowns: [], intakeOn: false }, after: { ...inp.after, waves: [] } }, freezeStart, freezeEnd, 0)[0]
  const waves = scheduledWaves(inp, freezeEnd)
  if (waves.some((wv) => wv.week >= W)) warnings.push('One or more waves fall beyond the horizon; their training still counts but the move does not happen.')
  if (freezeStart === 0 && inp.freeze.backfillBefore) warnings.push('The freeze starts in week 0, so pre-freeze backfill never applies.')

  const { paidHours, shrinkage, openHours } = inp.pool
  const alloc = allocShares(inp)
  const hours = inp.profile.hourShare.map((h) => openHours * h)
  const H0 = inp.pool.fte
  let H = H0
  const flows = { start: H0, hired: 0, attritionPre: 0, attritionFreeze: 0, attritionPost: 0, moved: 0, released: 0, end: 0 }
  let backlog = 0
  let backlogMoved = 0
  const weeks: WeekResult[] = []
  let trace: WeekTrace | undefined

  for (let w = 0; w < W; w++) {
    const d = demand[w]
    const phase = phaseOf(w, freezeStart, freezeEnd)
    const headsAtStart = H
    const backlogIn = backlog

    // 1. waves: staff and the work's email backlog leave with it, in sequence when they share a week
    let moved = 0
    for (const wv of waves)
      if (wv.week === w) {
        const m = H * wv.pct
        H -= m
        moved += m
        backlogMoved += backlog * wv.pct
        backlog *= 1 - wv.pct
      }

    // 2. attrition
    const mult = phase === 'pre' ? 1 : phase === 'freeze' ? tension : post
    const p = Math.min(1, (inp.attrition.annual / 52) * mult)
    const lost = opts.rng ? Math.min(H, binomial(opts.rng, Math.round(H), p)) : H * p
    H -= lost

    // 3. backfill, before the freeze only
    const hired = phase === 'pre' && inp.freeze.backfillBefore ? Math.max(0, H0 - H) : 0
    H += hired

    // 4. releases, only after the dismissal notice and never below the look-ahead need
    let released = 0
    if (inp.after.releasesOn && w >= freezeEnd + inp.after.noticeWeeks) {
      let need = 0
      for (let k = w; k <= Math.min(W - 1, w + inp.after.lookaheadWeeks); k++) need = Math.max(need, demand[k].fteReqNoBacklog)
      released = Math.max(0, H - (1 + inp.after.releaseBuffer) * need)
      H -= released
    }

    // 5. productive hours
    const surge = phase === 'post' && w < freezeEnd + inp.after.surgeWeeks ? surgePts : 0
    let trainingHours = 0
    for (const wv of waves)
      if (inp.after.trainingWeeks > 0 && w >= wv.week - inp.after.trainingWeeks && w < wv.week)
        trainingHours += (H * wv.pct * inp.after.trainingHours) / inp.after.trainingWeeks
    const P = Math.max(0, H * paidHours * (1 - Math.min(0.95, shrinkage + surge)) - trainingHours)
    const b = inp.borrowed
    const borrowActive = w >= b.startWeek && w <= b.endWeek && b.fte > 0
    const Bhome = borrowActive ? (b.fte * paidHours * (1 - shrinkage)) / Math.max(1, b.ahtPenalty) : 0

    // allocation by priority within each bucket (agents = hours / bucket hours)
    const nV = [0, 0, 0]
    const nC = [0, 0, 0]
    const leftIn: number[] = []
    const leftBor: number[] = []
    for (let k = 0; k < 3; k++) {
      let inAg = hours[k] > 0 ? (P * alloc[k]) / hours[k] : 0
      let borAg = hours[k] > 0 ? (Bhome * alloc[k]) / hours[k] : 0
      const take = (need: number, eligible: boolean) => {
        const fromB = eligible ? Math.min(borAg, need) : 0
        borAg -= fromB
        const fromI = Math.min(inAg, need - fromB)
        inAg -= fromI
        return fromB + fromI
      }
      nV[k] = take(d.buckets[k].needV, b.eligible.voice)
      nC[k] = take(d.buckets[k].needC, b.eligible.chat)
      leftIn.push(inAg)
      leftBor.push(borAg)
    }
    const nVBefore = [...nV]
    const nCBefore = [...nC]

    // email takes what is left, proportionally from each bucket
    const emailInH = leftIn.reduce((s, x, k) => s + x * hours[k], 0)
    const emailBorH = b.eligible.email ? leftBor.reduce((s, x, k) => s + x * hours[k], 0) : 0
    const emailCap = emailInH + emailBorH
    const due = backlog + d.emailArrivalHours
    const worked = Math.min(emailCap, due)
    backlog = due - worked
    const usedShare = emailCap > 0 ? worked / emailCap : 0

    // spare hours back to voice and chat, pro rata to need
    let borIdle = 0
    for (let k = 0; k < 3; k++) {
      const spareIn = leftIn[k] * (1 - usedShare)
      const spareBor = leftBor[k] * (b.eligible.email ? 1 - usedShare : 1)
      const nv = d.buckets[k].needV
      const nc = d.buckets[k].needC
      const tot = nv + nc
      if (tot > 0) {
        nV[k] += (spareIn * nv) / tot
        nC[k] += (spareIn * nc) / tot
        const eligV = b.eligible.voice && nv > 0
        const eligC = b.eligible.chat && nc > 0
        const eTot = (eligV ? nv : 0) + (eligC ? nc : 0)
        if (eTot > 0) {
          if (eligV) nV[k] += (spareBor * nv) / eTot
          if (eligC) nC[k] += (spareBor * nc) / eTot
        } else borIdle += spareBor * hours[k]
      } else borIdle += spareBor * hours[k]
    }
    const borrowedUsedHours = Math.max(0, Bhome - borIdle)

    const vs = inp.profile.volumeShare
    const interactive = (key: 'voice' | 'chat', ns: number[]): InteractiveWeek => {
      const volume = d.vol[key]
      const scored = volume >= SLIVER * base.vol[key] && base.vol[key] > 0
      let sl = 0
      let unstable = false
      let need = 0
      let given = 0
      for (let k = 0; k < 3; k++) {
        const bk = d.buckets[k]
        const cv = key === 'voice' ? bk.v : bk.c
        const n = ns[k]
        if (cv.a > 0 && n <= cv.a) unstable = true
        sl += vs[k] * cv.sl(n)
        need += (key === 'voice' ? bk.needV : bk.needC) * hours[k]
        given += n * hours[k]
      }
      return { volume, scored, sl: scored ? sl : NaN, need, given, unstable: scored && unstable }
    }
    const voice = interactive('voice', nV)
    const chat = interactive('chat', nC)

    const emailScored = d.vol.email >= SLIVER * base.vol.email && base.vol.email > 0
    const dailyArr = (d.emailArrivalHours > 0 ? d.emailArrivalHours : base.emailArrivalHours) / 5
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
    const score = !anyScored
      ? NaN // nothing left to serve: migration complete
      :
      (voice.unstable && voice.scored) || (chat.unstable && chat.scored)
        ? 0.05
        : meetsAll
          ? 0.7 + 0.3 * clamp((cover - 1) / 0.1)
          : 0.7 * clamp((Math.min(worst, 1) - 0.5) / 0.5)

    if (phase === 'pre') flows.attritionPre += lost
    else if (phase === 'freeze') flows.attritionFreeze += lost
    else flows.attritionPost += lost
    flows.hired += hired
    flows.moved += moved
    flows.released += released

    if (opts.traceWeek === w) {
      const names = ['peak', 'shoulder', 'off-peak']
      trace = {
        week: w,
        phase,
        headcount: { start: headsAtStart, moved, attritionRate: p, attritionMultiplier: mult, lost, hired, released, end: H },
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
          voice: { offeredErlangs: d.buckets[k].v.a, needAgents: d.buckets[k].needV, agentsBeforeSpare: nVBefore[k], agentsFinal: nV[k], serviceLevel: d.buckets[k].v.sl(nV[k]) },
          chat: { offeredErlangs: d.buckets[k].c.a, needAgents: d.buckets[k].needC, agentsBeforeSpare: nCBefore[k], agentsFinal: nC[k], serviceLevel: d.buckets[k].c.sl(nC[k]) },
          inHouseAgentsAvailable: hours[k] > 0 ? (P * alloc[k]) / hours[k] : 0,
          borrowedAgentsAvailable: hours[k] > 0 ? (Bhome * alloc[k]) / hours[k] : 0,
        })),
        email: { arrivalHours: d.emailArrivalHours, backlogIn, capacityHours: emailCap, workedHours: worked, backlogOut: backlog, dailyArrivalHours: dailyArr, backlogDays, targetDays, timeliness },
        required: { bucketBindHours: d.bucketBindHours, interactiveNeedHours: d.interactiveNeedHours, emailArrivalHours: d.emailArrivalHours, excessBacklogHours: excess, requiredHours: hReq, fteRequired: fteReq, fteAvailable: fteAvail },
        grade: { meetsAll, attainment: { voice: attain[0], chat: attain[1], email: attain[2] }, worstAttainment: worst, cover, unstable: (voice.unstable && voice.scored) || (chat.unstable && chat.scored), score },
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
      fteAvail,
      fteReq,
      utilisation,
      voice,
      chat,
      email,
      meetsAll,
      score,
    })
  }
  flows.end = H
  return { trace, weeks, flows, emailBacklogMovedHours: backlogMoved, freezeStart, freezeEnd, waveWeeks: waves.map((x) => x.week), warnings }
}
