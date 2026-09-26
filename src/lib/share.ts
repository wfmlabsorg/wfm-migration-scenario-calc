// Scenario <-> URL hash, so a copied link reproduces the scenario exactly.
// Links also record the engine commit (v=), so a scenario can be traced to the code that produced it.
import { DEFAULTS } from './defaults'
import { migrateV12Uncertainty, sanitiseRegister } from './register'
import type { Inputs, ProjectQuestion } from './types'
import { SHORT } from './version'

function merge<T>(base: T, patch: unknown): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (patch ?? base) as T
  const out = { ...base } as Record<string, unknown>
  if (patch && typeof patch === 'object')
    for (const [k, v] of Object.entries(patch)) if (k in out) out[k] = merge(out[k], v)
  return out as T
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
    // links made before v1.3 carried five PERT ranges instead of an assumption register
    inputs.assumptions = saved && typeof saved === 'object' && 'assumptions' in saved
      ? sanitiseRegister(saved.assumptions)
      : migrateV12Uncertainty(saved?.uncertainty)
    inputs.projectQuestions = sanitiseQuestions(saved?.projectQuestions)
    return inputs
  } catch {
    return null
  }
}
