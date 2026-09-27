// The assumption register: for each uncertain input, a range (low, likely, high) and how sure we
// are of it. The on-screen scenario always uses the likely value (the input field itself); the
// Monte Carlo draws every entry that has a range. Answering a question narrows its range, which
// narrows the bands.
import { PATH_META, QUESTIONS, pathRequires, type Requires } from './questions'
import type { Assumption, Inputs, Status, Triple } from './types'

/** Reads a numeric input by path. `freeze.length` is virtual: end − start. */
export function getPath(inp: Inputs, path: string): number {
  if (path === 'freeze.length') return inp.freeze.endWeek - inp.freeze.startWeek
  let node: unknown = inp
  for (const k of path.split('.')) node = (node as Record<string, unknown>)?.[k]
  return typeof node === 'number' ? node : NaN
}

/** Changing one share of a mix rescales the others so the mix still sums to 1. */
export function setShare(mix: Record<string, number>, key: string, value: number): void {
  const others = Object.keys(mix).filter((k) => k !== key)
  const rest = others.reduce((s, k) => s + mix[k], 0)
  for (const k of others) mix[k] = rest > 0 ? (mix[k] / rest) * (1 - value) : (1 - value) / others.length
  mix[key] = value
}

/** A path that is one share of a mix (book.contractMix.*, book.healthMix.*), or null. */
export function mixOf(path: string): { which: 'contractMix' | 'healthMix'; key: string } | null {
  const m = /^book\.(contractMix|healthMix)\.(\w+)$/.exec(path)
  return m ? { which: m[1] as 'contractMix' | 'healthMix', key: m[2] } : null
}

/** Writes a numeric input by path (clamped to its limits, rounded when it must be whole; a mix share rescales its siblings). */
export function setPath(inp: Inputs, path: string, value: number): void {
  const meta = PATH_META[path]
  let v = value
  if (meta) {
    v = Math.min(meta.max, Math.max(meta.min, v))
    if (meta.integer) v = Math.round(v)
  }
  if (path === 'freeze.length') {
    inp.freeze.endWeek = inp.freeze.startWeek + v
    return
  }
  const mix = mixOf(path)
  if (mix && inp.book) {
    setShare(inp.book[mix.which] as unknown as Record<string, number>, mix.key, v)
    return
  }
  const keys = path.split('.')
  let node = inp as unknown as Record<string, unknown>
  for (const k of keys.slice(0, -1)) node = node[k] as Record<string, unknown>
  node[keys[keys.length - 1]] = v
}

export const clampTriple = (path: string, [lo, mid, hi]: Triple): Triple => {
  const m = PATH_META[path]
  const c = (x: number) => (m ? Math.min(m.max, Math.max(m.min, x)) : x)
  const r = (x: number) => (m?.integer ? Math.round(x) : x)
  const l = r(c(Math.min(lo, mid)))
  const h = r(c(Math.max(hi, mid)))
  return [l, r(c(mid)), h]
}

/** The range an input carries at a given status. */
export function rangeFor(path: string, likely: number, status: Status, given?: Triple): Triple {
  if (PATH_META[path]?.lever) return [likely, likely, likely] // a decision is never drawn
  if (status === 'default' || !given) {
    const meta = PATH_META[path]
    if (status === 'confirmed' || !meta) return [likely, likely, likely]
    return clampTriple(path, meta.defaultRange(likely))
  }
  const t = clampTriple(path, [given[0], likely, given[2]])
  return status === 'confirmed' && given[0] === given[2] ? [likely, likely, likely] : t
}

/** A register with every generic question unanswered, around the scenario's current values. */
export function defaultRegister(inp: Inputs): Record<string, Assumption> {
  const reg: Record<string, Assumption> = {}
  for (const q of QUESTIONS)
    for (const path of q.sets) {
      if (PATH_META[path]) reg[path] = { range: rangeFor(path, getPath(inp, path), 'default'), status: 'default' }
      else reg[path] = { status: 'default' }
    }
  return reg
}

/**
 * Keeps the register in step after an input changes: likely = the input's value. An unanswered
 * entry re-centres its generic range; a confirmed point follows the input; an estimated range
 * keeps its bounds, widened if needed.
 */
export function syncRegister(inp: Inputs): void {
  for (const [path, a] of Object.entries(inp.assumptions)) {
    if (!a.range || !PATH_META[path]) continue
    const v = getPath(inp, path)
    if (!Number.isFinite(v) || v === a.range[1]) continue
    if (PATH_META[path].lever) a.range = [v, v, v]
    else if (a.status === 'default') a.range = rangeFor(path, v, 'default')
    else if (a.status === 'confirmed' && a.range[0] === a.range[2]) a.range = [v, v, v] // a confirmed point moves with its input and stays a point
    else a.range = clampTriple(path, [Math.min(a.range[0], v), v, Math.max(a.range[2], v)])
  }
}

/** Records an answer: sets the likely value on screen and the range and status in the register. */
export function recordAnswer(inp: Inputs, path: string, answer: { low?: number; likely: number; high?: number; status: Status; owner?: string; note?: string }): void {
  if (!PATH_META[path]) throw new Error(`"${path}" has no range in the register`)
  setPath(inp, path, answer.likely) // a mix share rescales its siblings (their register entries re-centre in syncRegister)
  const likely = getPath(inp, path)
  const given: Triple | undefined = answer.low !== undefined && answer.high !== undefined ? [answer.low, likely, answer.high] : undefined
  inp.assumptions[path] = {
    range: rangeFor(path, likely, answer.status, given ?? (answer.status === 'confirmed' ? [likely, likely, likely] : undefined)),
    status: answer.status,
    ...(answer.owner ? { owner: answer.owner } : {}),
    ...(answer.note ? { note: answer.note } : {}),
  }
  if (mixOf(path)) syncRegister(inp)
}

/** Whether a mode requirement is met by the scenario (split on, single stock, book mode). */
export function requirementMet(inp: Inputs, req: Requires | undefined): boolean {
  if (!req) return true
  if (req === 'split') return inp.people?.split === true
  if (req === 'nosplit') return inp.people?.split !== true
  if (req === 'manual') return inp.book?.mode !== 'book'
  return inp.book?.mode === 'book'
}

/** An input is active when the scenario is in the mode that uses it (people.* only when split, book.* only in book mode). */
export function activePath(inp: Inputs, path: string): boolean {
  return requirementMet(inp, pathRequires(path))
}

/** Entries the Monte Carlo draws (a range with width, in an active mode). */
export function drawn(inp: Inputs): [string, Triple][] {
  return Object.entries(inp.assumptions)
    .filter(([p, a]) => a.range && PATH_META[p] && a.range[2] > a.range[0] && activePath(inp, p))
    .map(([p, a]): [string, Triple] => [p, a.range!])
    .sort(([a], [b]) => (a < b ? -1 : 1))
}

/** Counts over the entries that apply in the scenario's mode. */
export function statusCounts(inp: Inputs): Record<Status, number> {
  const c = { default: 0, estimated: 0, confirmed: 0 }
  for (const [p, a] of Object.entries(inp.assumptions)) if (activePath(inp, p)) c[a.status]++
  return c
}

/** Keeps only well-formed entries (from links, cards or the analyst). */
export function sanitiseRegister(raw: unknown): Record<string, Assumption> {
  const out: Record<string, Assumption> = {}
  if (!raw || typeof raw !== 'object') return out
  const known = new Set([...Object.keys(PATH_META), ...QUESTIONS.flatMap((q) => q.sets)])
  for (const [path, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(path) || !v || typeof v !== 'object') continue
    const a = v as Record<string, unknown>
    const status = (['default', 'estimated', 'confirmed'] as const).find((s) => s === a.status)
    if (!status) continue
    const r = a.range
    const range = Array.isArray(r) && r.length === 3 && r.every((x) => typeof x === 'number' && Number.isFinite(x)) && PATH_META[path] ? clampTriple(path, r as Triple) : undefined
    const str = (x: unknown) => (typeof x === 'string' && x.length <= 200 ? x : undefined)
    out[path] = { ...(range ? { range } : {}), status, ...(str(a.owner) ? { owner: str(a.owner) } : {}), ...(str(a.note) ? { note: str(a.note) } : {}) }
  }
  return out
}

/** v1.2 links carried five PERT ranges in `uncertainty`; they become estimated register entries. */
export function migrateV12Uncertainty(u: Record<string, unknown> | undefined): Record<string, Assumption> {
  const map: Record<string, string> = {
    freezeLength: 'freeze.length',
    tensionMult: 'attrition.tensionMult',
    postMult: 'attrition.postMult',
    surgePts: 'after.surgePts',
    runoffPctWeek: 'demand.runoffPctWeek',
  }
  const out: Record<string, Assumption> = {}
  for (const [k, path] of Object.entries(map)) {
    const t = u?.[k]
    if (Array.isArray(t) && t.length === 3 && t.every((x) => typeof x === 'number' && Number.isFinite(x)))
      out[path] = { range: clampTriple(path, [Math.min(...(t as number[])), t[1] as number, Math.max(...(t as number[]))]), status: 'estimated' }
  }
  return out
}
