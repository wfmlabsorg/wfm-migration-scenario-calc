// Shape cards: a scenario without its scale. The Claude Desktop pack (or anyone) can hand the
// public tool the *shape* of a migration (timing, ratios, rates, handle times, ranges and how sure
// each one is) without real headcount, volumes or names. On import the tool rebuilds volumes
// for a reference team size so that week-0 cover and the workload mix match the card.
//
// Format 1 carries departures as a fixed staircase (step-downs and waves). Format 2 also carries
// the book itself (contract and health mix, fate priors, notice ranges, waves as shares of
// transferring work, wave slip) and the team's transfer/release split, so the tool can derive
// the departure curve and draw real staircases in its Monte Carlo. Both formats import.
import { BOOK_LIMITS, sanitiseBook, sanitisePeople } from './book'
import { cloneDefaults } from './defaults'
import { run } from './engine'
import { PATH_META } from './questions'
import { clampTriple, defaultRegister, sanitiseRegister, syncRegister } from './register'
import { sanitiseQuestions, sanitiseSpikes } from './share'
import type { Assumption, Inputs, ProjectQuestion, Triple } from './types'

export const CARD_FORMAT_1 = 'wfm-migration-shape-card/1'
export const CARD_FORMAT = 'wfm-migration-shape-card/2'
export const CARD_FORMATS = [CARD_FORMAT_1, CARD_FORMAT] as const

export interface ShapeCard {
  format: (typeof CARD_FORMATS)[number]
  title: string
  created: string
  note?: string // a caveat the exporter attached (e.g. that departures are an expected staircase)
  cover?: number // week 0: available ÷ required FTE (cards exported by this tool)
  occupancy?: number // week 0: offered workload hours ÷ productive hours (cards exported by the desktop pack); used when cover is absent
  mix: { voice: number; chat: number; email: number } // share of offered workload hours
  borrowedShare: number // borrowed FTE ÷ team FTE
  scenario: Record<string, unknown> // the scenario with volumes and headcount removed
  assumptions: Record<string, Assumption> // scaled inputs (volumes, borrowed FTE) carry ranges relative to 1
  questions: ProjectQuestion[]
}

const CHANNELS = ['voice', 'chat', 'email'] as const

function workloadHours(i: Inputs) {
  const c = i.channels
  return {
    voice: (c.voice.volume * c.voice.aht) / 3600,
    chat: (c.chat.volume * c.chat.aht) / Math.max(1, c.chat.concurrency) / 3600,
    email: (c.email.volume * c.email.aht) / 3600,
  }
}

function weekZeroCover(i: Inputs): number {
  const w = run({ ...i, horizonWeeks: 1 }).weeks[0]
  return w.fteReq > 0 ? w.fteAvail / w.fteReq : Infinity
}

/** Builds a card from the scenario on screen. Nothing absolute leaves: volumes and FTE become ratios. */
export function toShapeCard(inp: Inputs, title = 'Migration scenario'): ShapeCard {
  const wl = workloadHours(inp)
  const total = wl.voice + wl.chat + wl.email || 1
  const scenario = structuredClone(inp) as unknown as Record<string, unknown>
  const ch = scenario.channels as Record<string, Record<string, unknown>>
  for (const c of CHANNELS) delete ch[c].volume
  delete (scenario.pool as Record<string, unknown>).fte
  delete (scenario.borrowed as Record<string, unknown>).fte
  delete scenario.assumptions
  delete scenario.projectQuestions
  const assumptions: Record<string, Assumption> = {}
  for (const [path, a] of Object.entries(inp.assumptions)) {
    if (PATH_META[path]?.scaled && a.range) {
      // relative to the likely value; a scaled input at 0 (e.g. no borrowed staff) has no relative range
      const v = a.range[1]
      const rel: [number, number, number] = v > 0 ? [Math.max(0.2, a.range[0] / v), 1, Math.min(5, Math.max(1, a.range[2] / v))] : [1, 1, 1]
      assumptions[path] = { ...a, range: rel }
    } else assumptions[path] = a
  }
  return {
    format: CARD_FORMAT,
    title: title.slice(0, 120),
    created: new Date().toISOString().slice(0, 10),
    cover: weekZeroCover(inp),
    mix: { voice: wl.voice / total, chat: wl.chat / total, email: wl.email / total },
    borrowedShare: inp.pool.fte > 0 ? inp.borrowed.fte / inp.pool.fte : 0,
    scenario,
    assumptions,
    questions: inp.projectQuestions,
  }
}

function merge<T>(base: T, patch: unknown): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (patch ?? base) as T
  const out = { ...base } as Record<string, unknown>
  if (patch && typeof patch === 'object')
    for (const [k, v] of Object.entries(patch)) if (k in out) out[k] = merge(out[k], v)
  return out as T
}

function hasLongString(x: unknown): boolean {
  if (typeof x === 'string') return x.length > 200
  if (Array.isArray(x)) return x.some(hasLongString)
  if (x && typeof x === 'object') return Object.values(x).some(hasLongString)
  return false
}

/** Caveats to show the user after an import: the card's own note, plus what the modeler cannot carry. */
export function cardWarnings(raw: unknown): string[] {
  const out: string[] = []
  if (!raw || typeof raw !== 'object') return out
  const c = raw as Record<string, unknown>
  if (typeof c.note === 'string' && c.note.length <= 200) out.push(c.note)
  const s = (c.scenario ?? {}) as Record<string, Record<string, unknown>>
  const steps = (s.demand?.stepDowns as unknown[] | undefined)?.length ?? 0
  if (steps > 0) out.push('Step-downs are fixed calendar weeks: they do not move with the freeze length.')
  if (typeof c.occupancy === 'number' && typeof c.cover !== 'number') out.push('Volumes were rebuilt from week-0 occupancy for the team size you chose; pick a size near the real one, because bigger pools serve better at the same occupancy.')
  if (c.format === CARD_FORMAT_1 || !s.book) out.push('This card carries departures as a fixed staircase; a v2 card from pack ≥ 1.2 carries the book itself.')
  return out
}

const share = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1
const triple = (x: unknown): x is Triple => Array.isArray(x) && x.length === 3 && x.every((v) => typeof v === 'number' && Number.isFinite(v)) && x[0] <= x[1] && x[1] <= x[2]
const sumsToOne = (o: Record<string, unknown>, keys: string[]) => keys.every((k) => share(o[k])) && Math.abs(keys.reduce((t, k) => t + (o[k] as number), 0) - 1) < 1e-3

/** Validates a v2 book block: shares, probabilities, ranges and weeks only. */
function checkBook(b: unknown): string | null {
  if (!b || typeof b !== 'object') return 'book must be an object'
  const o = b as Record<string, any>
  if (o.mode !== 'manual' && o.mode !== 'book') return 'book.mode must be manual or book'
  if (!o.contractMix || !sumsToOne(o.contractMix, ['fixed', 'evergreen', 'tfc'])) return 'book.contractMix must be three shares summing to 1'
  if (!o.healthMix || !sumsToOne(o.healthMix, ['green', 'amber', 'red'])) return 'book.healthMix must be three shares summing to 1'
  for (const h of ['green', 'amber', 'red']) if (!o.priors?.[h] || !sumsToOne(o.priors[h], ['transfer', 'exit', 'replatform'])) return `book.priors.${h} must be three probabilities summing to 1`
  if (!Array.isArray(o.fixedExpiry) || o.fixedExpiry.length !== 2 || !o.fixedExpiry.every((v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= BOOK_LIMITS.expiry) || o.fixedExpiry[0] > o.fixedExpiry[1]) return `book.fixedExpiry must be [first, last] whole weeks within 0–${BOOK_LIMITS.expiry}`
  const weeks = (t: unknown, hi: number) => triple(t) && t[0] >= 0 && t[2] <= hi
  if (!o.exitNotice || !weeks(o.exitNotice.evergreen, BOOK_LIMITS.notice) || !weeks(o.exitNotice.tfc, BOOK_LIMITS.notice)) return `book.exitNotice ranges must be [low, likely, high] within 0–${BOOK_LIMITS.notice} weeks`
  if (!weeks(o.replatformOffset, BOOK_LIMITS.replatform)) return `book.replatformOffset must be [low, likely, high] within 0–${BOOK_LIMITS.replatform} weeks`
  if (!weeks(o.waveSlip, BOOK_LIMITS.slip)) return `book.waveSlip must be [low, likely, high] within 0–${BOOK_LIMITS.slip} weeks`
  if (!Array.isArray(o.waves) || o.waves.length > 4 || !o.waves.every((w: any) => w && Number.isInteger(w.weeksAfterFreeze) && w.weeksAfterFreeze >= 0 && w.weeksAfterFreeze <= 77 && share(w.pct))) return 'book.waves must be at most 4 {weeksAfterFreeze, pct} with pct 0–1'
  if (!(Number.isInteger(o.granularity) && o.granularity >= 5 && o.granularity <= 200)) return 'book.granularity must be a whole number 5–200'
  const allowed = new Set(['mode', 'contractMix', 'fixedExpiry', 'healthMix', 'priors', 'exitNotice', 'replatformOffset', 'waves', 'waveSlip', 'granularity'])
  for (const k of Object.keys(o)) if (!allowed.has(k)) return `book.${k} is not part of a shape card`
  return null
}

function checkPeople(p: unknown): string | null {
  if (!p || typeof p !== 'object') return 'people must be an object'
  const o = p as Record<string, unknown>
  if (typeof o.split !== 'boolean') return 'people.split must be true/false'
  const mult = (k: string, lo: number) => typeof o[k] === 'number' && Number.isFinite(o[k] as number) && (o[k] as number) >= lo && (o[k] as number) <= 8
  if (!mult('postMultTransfer', 0.5)) return 'people.postMultTransfer must be a multiplier 0.5–8'
  if (!mult('postMultRelease', 1)) return 'people.postMultRelease must be a multiplier 1–8'
  if (!share(o.retentionEffect)) return 'people.retentionEffect must be 0–1'
  if (!['release', 'transfer', 'both'].includes(o.retentionTarget as string)) return 'people.retentionTarget must be release, transfer or both'
  const allowed = new Set(['split', 'postMultTransfer', 'postMultRelease', 'retentionEffect', 'retentionTarget'])
  for (const k of Object.keys(o)) if (!allowed.has(k)) return `people.${k} is not part of a shape card`
  return null
}

/** Rejects anything that is not a scale-free card. Returns a readable reason. */
export function checkCard(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'Not a shape card (expected a JSON object).'
  const c = raw as Record<string, unknown>
  if (!CARD_FORMATS.includes(c.format as never)) return `Unknown format "${String(c.format)}"; expected ${CARD_FORMATS.join(' or ')}.`
  const s = c.scenario as Record<string, Record<string, unknown>> | undefined
  if (!s || typeof s !== 'object') return 'The card has no scenario.'
  if (c.format === CARD_FORMAT_1 && ('book' in s || 'people' in s)) return 'A format-1 card cannot carry a book or people block.'
  if ('book' in s) { const why = checkBook(s.book); if (why) return why }
  if ('people' in s) { const why = checkPeople(s.people); if (why) return why }
  const chans = (s.channels ?? {}) as Record<string, Record<string, unknown>>
  if (CHANNELS.some((k) => chans[k] && 'volume' in chans[k])) return 'The card contains absolute volumes. Shape cards carry the workload mix and cover instead.'
  if (s.pool && 'fte' in s.pool) return 'The card contains team headcount. Shape cards carry cover and shares instead.'
  if (s.borrowed && 'fte' in s.borrowed) return 'The card contains borrowed headcount. Use borrowedShare instead.'
  const okCover = typeof c.cover === 'number' && c.cover > 0.2 && c.cover < 5
  const okOcc = typeof c.occupancy === 'number' && c.occupancy > 0.05 && c.occupancy < 3
  if (!okCover && !okOcc) return 'The card needs week-0 cover (0.2–5) or occupancy (0.05–3).'
  const m = c.mix as Record<string, unknown> | undefined
  if (!m || !CHANNELS.every((k) => typeof m[k] === 'number' && (m[k] as number) >= 0)) return 'Mix must give voice, chat and email shares.'
  if (hasLongString(raw)) return 'The card contains a text longer than 200 characters.'
  // ranges on volumes and headcount travel relative to 1; an absolute range would carry scale
  const asm = (c.assumptions ?? {}) as Record<string, { range?: unknown }>
  for (const [path, a] of Object.entries(asm)) {
    if (!PATH_META[path]?.scaled || !a || typeof a !== 'object' || !Array.isArray(a.range)) continue
    const r = a.range as unknown[]
    if (r.length !== 3 || !r.every((x) => typeof x === 'number' && Number.isFinite(x))) return `The card's range for ${path} is malformed.`
    const [lo, mid, hi] = r as number[]
    if (Math.abs(mid - 1) > 1e-6 || lo < 0.2 || hi > 5 || lo > mid || mid > hi) return `The card carries an absolute range for ${path}; shape cards carry ranges relative to 1 (0.2–5).`
  }
  return null
}

/**
 * Rebuilds a full scenario from a card for a team of `teamFte`: volumes follow the card's
 * workload mix, scaled so week-0 cover matches (bisection on total workload).
 */
export function fromShapeCard(raw: unknown, teamFte = 250): Inputs {
  const why = checkCard(raw)
  if (why) throw new Error(why)
  const card = raw as ShapeCard
  const inp = merge(cloneDefaults(), card.scenario)
  // the book and people blocks pass through the same sanitising as a link (bounds, whole weeks, shares)
  const fb = cloneDefaults()
  inp.book = sanitiseBook(inp.book, fb.book)
  inp.people = sanitisePeople(inp.people, fb.people)
  inp.pool.fte = teamFte
  inp.borrowed.fte = Math.max(0, (card.borrowedShare ?? 0) * teamFte)
  const mixTotal = card.mix.voice + card.mix.chat + card.mix.email || 1
  const setWorkload = (hours: number) => {
    const c = inp.channels
    c.voice.volume = ((card.mix.voice / mixTotal) * hours * 3600) / c.voice.aht
    c.chat.volume = ((card.mix.chat / mixTotal) * hours * 3600 * Math.max(1, c.chat.concurrency)) / c.chat.aht
    c.email.volume = ((card.mix.email / mixTotal) * hours * 3600) / c.email.aht
  }
  if (typeof card.cover === 'number' && card.cover > 0) {
    // cover falls as workload rises; bisect in log space
    let lo = 1
    let hi = teamFte * inp.pool.paidHours * 4
    for (let k = 0; k < 60; k++) {
      const mid = Math.sqrt(lo * hi)
      setWorkload(mid)
      if (weekZeroCover(inp) > card.cover) lo = mid
      else hi = mid
    }
    setWorkload(Math.sqrt(lo * hi))
  } else {
    // occupancy: offered workload = occupancy × week-0 productive hours
    setWorkload(card.occupancy! * teamFte * inp.pool.paidHours * (1 - inp.pool.shrinkage))
  }
  for (const c of CHANNELS) inp.channels[c].volume = Math.round(inp.channels[c].volume)
  // register: the card's entries over a full "not asked" register, so inputs the card does not
  // mention stay unanswered (and drawn) rather than becoming fixed points
  const reg = { ...defaultRegister(inp), ...sanitiseRegister(card.assumptions) }
  for (const [path, a] of Object.entries(reg)) {
    if (PATH_META[path]?.scaled && a.range) {
      const keys = path.split('.')
      let node: unknown = inp
      for (const k of keys) node = (node as Record<string, unknown>)[k]
      const v = node as number
      a.range = clampTriple(path, [a.range[0] * v, v, a.range[2] * v])
    }
  }
  inp.assumptions = reg
  inp.projectQuestions = sanitiseQuestions(card.questions)
  inp.seasonality = { spikes: sanitiseSpikes((card.scenario as { seasonality?: { spikes?: unknown } }).seasonality?.spikes) }
  inp.uncertainty.enabled = true
  syncRegister(inp)
  return inp
}
