// Shape cards: a scenario without its scale. The Claude Desktop pack (or anyone) can hand the
// public tool the *shape* of a migration (timing, ratios, rates, handle times, ranges and how sure
// each one is) without real headcount, volumes or names. On import the tool rebuilds volumes
// for a reference team size so that week-0 cover and the workload mix match the card.
import { cloneDefaults } from './defaults'
import { run } from './engine'
import { PATH_META } from './questions'
import { sanitiseRegister, syncRegister } from './register'
import { sanitiseQuestions } from './share'
import type { Assumption, Inputs, ProjectQuestion } from './types'

export const CARD_FORMAT = 'wfm-migration-shape-card/1'

export interface ShapeCard {
  format: typeof CARD_FORMAT
  title: string
  created: string
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
      const v = a.range[1] || 1
      assumptions[path] = { ...a, range: [a.range[0] / v, 1, a.range[2] / v] }
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

/** Rejects anything that is not a scale-free card. Returns a readable reason. */
export function checkCard(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'Not a shape card (expected a JSON object).'
  const c = raw as Record<string, unknown>
  if (c.format !== CARD_FORMAT) return `Unknown format "${String(c.format)}"; expected ${CARD_FORMAT}.`
  const s = c.scenario as Record<string, Record<string, unknown>> | undefined
  if (!s || typeof s !== 'object') return 'The card has no scenario.'
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
  // register: relative ranges on scaled inputs become absolute around the rebuilt values
  const reg = sanitiseRegister(card.assumptions)
  for (const [path, a] of Object.entries(reg)) {
    if (PATH_META[path]?.scaled && a.range) {
      const keys = path.split('.')
      let node: unknown = inp
      for (const k of keys) node = (node as Record<string, unknown>)[k]
      const v = node as number
      a.range = [a.range[0] * v, v, a.range[2] * v]
    }
  }
  inp.assumptions = reg
  inp.projectQuestions = sanitiseQuestions(card.questions)
  inp.uncertainty.enabled = true
  syncRegister(inp)
  return inp
}
