// The only inputs the analyst may change, with ranges. Anything else is refused.
import { normaliseMixes, validateBook } from '../lib/book'
import { syncRegister } from '../lib/register'
import type { Balance, BalanceMode, Book, Channel, Inputs, StepDown, Wave } from '../lib/types'

export interface PathSpec {
  path: string
  min: number
  max: number
  integer?: boolean
  boolean?: boolean // value 0 or 1
  describe: string
}

export const PATHS: PathSpec[] = [
  { path: 'horizonWeeks', min: 13, max: 78, integer: true, describe: 'Weeks simulated' },
  { path: 'channels.voice.volume', min: 0, max: 500000, describe: 'Voice contacts per week' },
  { path: 'channels.voice.aht', min: 30, max: 3600, describe: 'Voice AHT, seconds' },
  { path: 'channels.voice.slTarget', min: 0.05, max: 0.99, describe: 'Voice target share answered in time (0–1)' },
  { path: 'channels.voice.slSeconds', min: 1, max: 600, describe: 'Voice answer threshold, seconds' },
  { path: 'channels.chat.volume', min: 0, max: 500000, describe: 'Chats per week' },
  { path: 'channels.chat.aht', min: 30, max: 7200, describe: 'Chat handle time, seconds' },
  { path: 'channels.chat.slTarget', min: 0.05, max: 0.99, describe: 'Chat target share answered in time (0–1)' },
  { path: 'channels.chat.slSeconds', min: 1, max: 600, describe: 'Chat answer threshold, seconds' },
  { path: 'channels.chat.concurrency', min: 1, max: 6, describe: 'Chats handled at once' },
  { path: 'channels.email.volume', min: 0, max: 500000, describe: 'Emails per week' },
  { path: 'channels.email.aht', min: 30, max: 7200, describe: 'Email handle time, seconds' },
  { path: 'channels.email.targetDays', min: 0.25, max: 20, describe: 'Email turnaround target, days' },
  { path: 'pool.fte', min: 0, max: 10000, describe: 'Starting frontline headcount' },
  { path: 'pool.shrinkage', min: 0, max: 0.6, describe: 'Total shrinkage (0–0.6)' },
  { path: 'pool.paidHours', min: 10, max: 60, describe: 'Paid hours per head per week' },
  { path: 'pool.openHours', min: 10, max: 168, describe: 'Hours the queues are open per week' },
  { path: 'profile.scheduleFit', min: 0, max: 1, describe: 'How closely staffing follows the intraday demand shape (0 flat, 1 perfect)' },
  { path: 'attrition.annual', min: 0, max: 1, describe: 'Base annual attrition (0–1)' },
  { path: 'attrition.tensionMult', min: 1, max: 6, describe: 'Attrition multiplier during the freeze' },
  { path: 'attrition.postMult', min: 1, max: 8, describe: 'Attrition multiplier after the announcement' },
  { path: 'freeze.startWeek', min: 0, max: 77, integer: true, describe: 'Freeze start week' },
  { path: 'freeze.endWeek', min: 0, max: 77, integer: true, describe: 'Freeze end week (announcement)' },
  { path: 'freeze.backfillBefore', min: 0, max: 1, boolean: true, describe: 'Backfill leavers before the freeze (1 yes, 0 no)' },
  { path: 'demand.runoffPctWeek', min: 0, max: 0.2, describe: 'Weekly runoff of the existing book (0–0.2)' },
  { path: 'demand.runoffStartWeek', min: 0, max: 77, integer: true, describe: 'Week runoff starts' },
  { path: 'demand.intakeOn', min: 0, max: 1, boolean: true, describe: 'Taking on new demand (1 yes, 0 no)' },
  { path: 'demand.intakePct', min: 0, max: 1.5, describe: 'Share of runoff replaced by new demand' },
  { path: 'after.trainingHours', min: 0, max: 200, describe: 'Training hours per transferee before their wave' },
  { path: 'after.trainingWeeks', min: 1, max: 20, integer: true, describe: 'Weeks before a wave over which training is spread' },
  { path: 'after.surgePts', min: 0, max: 0.3, describe: 'Extra shrinkage after the announcement (0–0.3)' },
  { path: 'after.surgeWeeks', min: 0, max: 52, integer: true, describe: 'Weeks the absence surge lasts' },
  { path: 'after.releasesOn', min: 0, max: 1, boolean: true, describe: 'Release surplus staff after notice (1 yes, 0 no)' },
  { path: 'after.noticeWeeks', min: 0, max: 26, integer: true, describe: 'Notice weeks before releases' },
  { path: 'after.releaseBuffer', min: 0, max: 0.5, describe: 'Headroom kept above need when releasing' },
  { path: 'service.useErlangA', min: 0, max: 1, boolean: true, describe: 'Delivered service model: 1 Erlang A (customers abandon), 0 Erlang C (nobody abandons). Required FTE is always sized with Erlang C' },
  { path: 'service.patience.voice', min: 5, max: 3600, describe: 'Erlang A: mean seconds a waiting caller stays before hanging up' },
  { path: 'service.patience.chat', min: 5, max: 3600, describe: 'Erlang A: mean seconds a waiting chat customer stays before leaving' },
  { path: 'service.redialRate', min: 0, max: 1, describe: 'Erlang A: share of extra abandoners who try again next week (0–1)' },
  { path: 'service.abandonCap', min: 0.01, max: 0.5, describe: 'Erlang A: worst voice/chat abandonment above this caps the week at BBB, above twice it at CCC' },
  { path: 'people.split', min: 0, max: 1, boolean: true, describe: 'Split the team at the announcement into a transfer group and a release group (1 yes, 0 no: one stock with attrition.postMult)' },
  { path: 'people.postMultTransfer', min: 1, max: 8, describe: 'Split on: attrition multiplier after the announcement for staff transferring with the work' },
  { path: 'people.postMultRelease', min: 1, max: 8, describe: 'Split on: attrition multiplier after the announcement for staff to be released' },
  { path: 'people.retentionEffect', min: 0, max: 1, describe: 'Split on: retention offer cuts post-announcement leaving of the target group by this share (0–1); a lever' },
  { path: 'book.useBook', min: 0, max: 1, boolean: true, describe: 'Describe departures by the book of business (1) instead of manual step-downs, runoff and waves (0). Use set_book to change the book itself' },
  { path: 'book.contractMix.fixed', min: 0, max: 1, describe: 'Book mode: share of workload on fixed-term contracts (the other contract shares rescale)' },
  { path: 'book.contractMix.evergreen', min: 0, max: 1, describe: 'Book mode: share on rolling contracts' },
  { path: 'book.contractMix.tfc', min: 0, max: 1, describe: 'Book mode: share on rolling contracts with a termination-for-convenience clause' },
  { path: 'book.healthMix.green', min: 0, max: 1, describe: 'Book mode: share of workload rated green (the other health shares rescale)' },
  { path: 'book.healthMix.amber', min: 0, max: 1, describe: 'Book mode: share rated amber' },
  { path: 'book.healthMix.red', min: 0, max: 1, describe: 'Book mode: share rated red' },
  { path: 'book.granularity', min: 5, max: 200, integer: true, describe: 'Book mode: client-equivalents sampled per simulated future' },
  { path: 'balance.emailFloor', min: 0, max: 1, describe: 'Protect-email policy: share of email arrivals guaranteed first (0–1)' },
  { path: 'borrowed.fte', min: 0, max: 2000, describe: 'Borrowed FTE from another site' },
  { path: 'borrowed.startWeek', min: 0, max: 77, integer: true, describe: 'First week borrowed staff help' },
  { path: 'borrowed.endWeek', min: 0, max: 77, integer: true, describe: 'Last week borrowed staff help' },
  { path: 'borrowed.ahtPenalty', min: 1, max: 3, describe: 'How much slower borrowed staff are (≥1)' },
  { path: 'borrowed.eligible.voice', min: 0, max: 1, boolean: true, describe: 'Borrowed staff can take voice (1/0)' },
  { path: 'borrowed.eligible.chat', min: 0, max: 1, boolean: true, describe: 'Borrowed staff can take chat (1/0)' },
  { path: 'borrowed.eligible.email', min: 0, max: 1, boolean: true, describe: 'Borrowed staff can take email (1/0)' },
]

const SPEC = new Map(PATHS.map((p) => [p.path, p]))

export interface Change {
  path: string
  value: number
}

export interface Changes {
  changes?: Change[]
  waves?: Wave[] // replaces all waves when present
  stepDowns?: StepDown[] // replaces all step-downs when present
  balance?: { mode: string; order: string[]; emailFloor: number } // replaces the balancing policy when present
  book?: unknown // replaces the whole book block when present (validated)
}

/** Changing one share of a mix rescales the others so the mix still sums to 1. */
function setShare(mix: Record<string, number>, key: string, value: number): void {
  const others = Object.keys(mix).filter((k) => k !== key)
  const rest = others.reduce((s, k) => s + mix[k], 0)
  for (const k of others) mix[k] = rest > 0 ? (mix[k] / rest) * (1 - value) : (1 - value) / others.length
  mix[key] = value
}

/** Validates and applies changes to a copy of the inputs. Throws with a readable message on anything invalid. */
export function applyChanges(base: Inputs, c: Changes): Inputs {
  const next = structuredClone(base)
  for (const ch of c.changes ?? []) {
    const spec = SPEC.get(ch.path)
    if (!spec) throw new Error(`Unknown input "${ch.path}". Allowed: ${PATHS.map((p) => p.path).join(', ')}`)
    const v = Number(ch.value)
    if (!Number.isFinite(v) || v < spec.min || v > spec.max) throw new Error(`${ch.path} must be between ${spec.min} and ${spec.max} (got ${ch.value})`)
    if (spec.integer && !Number.isInteger(v)) throw new Error(`${ch.path} must be a whole number (got ${ch.value})`)
    if (spec.boolean && v !== 0 && v !== 1) throw new Error(`${ch.path} must be 0 or 1 (got ${ch.value})`)
    if (ch.path === 'service.useErlangA') {
      next.service.model = v === 1 ? 'A' : 'C'
      continue
    }
    if (ch.path === 'people.split') {
      next.people.split = v === 1
      continue
    }
    if (ch.path === 'book.useBook') {
      next.book.mode = v === 1 ? 'book' : 'manual'
      continue
    }
    if (ch.path.startsWith('book.contractMix.') || ch.path.startsWith('book.healthMix.')) {
      const [, which, key] = ch.path.split('.')
      setShare(next.book[which as 'contractMix' | 'healthMix'] as unknown as Record<string, number>, key, v)
      continue
    }
    const keys = ch.path.split('.')
    let node = next as unknown as Record<string, unknown>
    for (const k of keys.slice(0, -1)) node = node[k] as Record<string, unknown>
    node[keys[keys.length - 1]] = spec.boolean ? v === 1 : v
  }
  if (c.waves) {
    if (c.waves.length > 4) throw new Error('At most 4 waves')
    for (const w of c.waves) {
      if (!Number.isInteger(w.weeksAfterFreeze) || w.weeksAfterFreeze < 0 || w.weeksAfterFreeze > 77) throw new Error('Wave weeksAfterFreeze must be a whole number 0–77')
      if (!(w.pct >= 0 && w.pct <= 1)) throw new Error('Wave pct must be 0–1 (share of the book)')
    }
    next.after.waves = c.waves.map((w) => ({ weeksAfterFreeze: w.weeksAfterFreeze, pct: w.pct }))
  }
  if (c.stepDowns) {
    if (c.stepDowns.length > 12) throw new Error('At most 12 step-downs')
    for (const s of c.stepDowns) {
      if (!Number.isInteger(s.week) || s.week < 0 || s.week > 77) throw new Error('Step-down week must be a whole number 0–77')
      if (!(s.pct >= 0 && s.pct <= 1)) throw new Error('Step-down pct must be 0–1')
    }
    next.demand.stepDowns = c.stepDowns.map((s) => ({ week: s.week, pct: s.pct }))
  }
  if (c.book !== undefined) {
    next.book = validateBook(c.book) satisfies Book
    normaliseMixes(next)
  }
  if (c.balance) {
    const modes: BalanceMode[] = ['priority', 'floor', 'prorata', 'equal']
    const chans: Channel[] = ['voice', 'chat', 'email']
    if (!modes.includes(c.balance.mode as BalanceMode)) throw new Error(`balance mode must be one of ${modes.join(', ')}`)
    const o = c.balance.order
    if (!Array.isArray(o) || o.length !== 3 || new Set(o).size !== 3 || !o.every((x) => chans.includes(x as Channel)))
      throw new Error('balance order must list voice, chat and email once each')
    if (!(c.balance.emailFloor >= 0 && c.balance.emailFloor <= 1)) throw new Error('balance email_floor must be 0–1')
    next.balance = { mode: c.balance.mode as BalanceMode, order: o as Channel[], emailFloor: c.balance.emailFloor } satisfies Balance
  }
  syncRegister(next) // the register's likely values must follow the inputs, or the Monte Carlo draws around stale centres
  return next
}
