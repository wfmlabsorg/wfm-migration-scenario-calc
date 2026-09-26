// Scenario <-> URL hash, so a copied link reproduces the scenario exactly.
// Links also record the engine commit (v=), so a scenario can be traced to the code that produced it.
import { sanitiseBook, sanitisePeople } from './book'
import { DEFAULTS } from './defaults'
import { defaultRegister, migrateV12Uncertainty, sanitiseRegister } from './register'
import type { Inputs, ProjectQuestion } from './types'
import { SHORT } from './version'

function merge<T>(base: T, patch: unknown): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (patch ?? base) as T
  const out = { ...base } as Record<string, unknown>
  if (patch && typeof patch === 'object')
    for (const [k, v] of Object.entries(patch)) if (k in out) out[k] = merge(out[k], v)
  return out as T
}

/** Waves / step-downs from a link: whole weeks in range, shares 0–1, at most `max` entries. */
function sanitiseList<K extends string>(raw: unknown, weekKey: K, max: number): ({ [k in K]: number } & { pct: number })[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({ week: Number(x[weekKey]), pct: Number(x.pct) }))
    .filter((x) => Number.isInteger(x.week) && x.week >= 0 && x.week <= 77 && x.pct >= 0 && x.pct <= 1)
    .slice(0, max)
    .map((x) => ({ [weekKey]: x.week, pct: x.pct }) as { [k in K]: number } & { pct: number })
}

/** Project questions from a link or card: short strings, known shapes only. */
export function sanitiseQuestions(raw: unknown): ProjectQuestion[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((q): q is ProjectQuestion => !!q && typeof q.id === 'string' && typeof q.text === 'string' && Array.isArray(q.sets))
    .slice(0, 40)
    .map((q) => ({ id: q.id.slice(0, 20), text: q.text.slice(0, 200), sets: q.sets.filter((x) => typeof x === 'string').slice(0, 8) }))
}

export function encode(inputs: Inputs): string {
  const bytes = new TextEncoder().encode(JSON.stringify(inputs))
  let bin = ''
  bytes.forEach((b) => (bin += String.fromCharCode(b)))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Full hash fragment for a scenario: `s=<scenario>&v=<commit>`. */
export function toHash(inputs: Inputs, commit = SHORT): string {
  return `s=${encode(inputs)}&v=${commit}`
}

/** Engine commit recorded in a hash, or null for links made before versioning. */
export function commitOf(hash: string): string | null {
  const m = /(?:^#?|&)v=([0-9a-f]{7,40}|unknown)/.exec(hash)
  return m ? m[1] : null
}

/** Decodes a hash; unknown keys are ignored and missing ones take defaults, so old links keep working. */
export function decode(hash: string): Inputs | null {
  try {
    const m = /(?:^#?|&)s=([A-Za-z0-9_-]+)/.exec(hash)
    if (!m) return null
    const s = m[1].replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    const saved = JSON.parse(new TextDecoder().decode(bytes))
    const inputs = merge(structuredClone(DEFAULTS), saved)
    // links made before v1.2 have no service model: they were computed with Erlang C and must stay so
    if (!saved || typeof saved !== 'object' || !('service' in saved)) inputs.service = { ...inputs.service, model: 'C' }
    inputs.horizonWeeks = Number.isFinite(inputs.horizonWeeks) ? Math.min(78, Math.max(13, Math.round(inputs.horizonWeeks))) : DEFAULTS.horizonWeeks
    inputs.after.waves = sanitiseList(inputs.after.waves, 'weeksAfterFreeze', 4)
    inputs.demand.stepDowns = sanitiseList(inputs.demand.stepDowns, 'week', 12)
    // links made before v1.4 have neither block: one stock, manual departures
    inputs.people = sanitisePeople(saved?.people, DEFAULTS.people)
    inputs.book = sanitiseBook(saved?.book, DEFAULTS.book)
    // links made before v1.3 carried five PERT ranges instead of an assumption register;
    // every question the link does not answer starts unasked (its generic range)
    const saved_ = saved && typeof saved === 'object' && 'assumptions' in saved ? sanitiseRegister(saved.assumptions) : migrateV12Uncertainty(saved?.uncertainty)
    inputs.assumptions = { ...defaultRegister(inputs), ...saved_ }
    inputs.projectQuestions = sanitiseQuestions(saved?.projectQuestions)
    return inputs
  } catch {
    return null
  }
}
