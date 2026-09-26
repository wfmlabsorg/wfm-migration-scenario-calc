// Scenario <-> URL hash, so a copied link reproduces the scenario exactly.
import { DEFAULTS } from './defaults'
import type { Inputs } from './types'

function merge<T>(base: T, patch: unknown): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (patch ?? base) as T
  const out = { ...base } as Record<string, unknown>
  if (patch && typeof patch === 'object')
    for (const [k, v] of Object.entries(patch)) if (k in out) out[k] = merge(out[k], v)
  return out as T
}

export function encode(inputs: Inputs): string {
  const bytes = new TextEncoder().encode(JSON.stringify(inputs))
  let bin = ''
  bytes.forEach((b) => (bin += String.fromCharCode(b)))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decodes a hash; unknown keys are ignored and missing ones take defaults, so old links keep working. */
export function decode(hash: string): Inputs | null {
  try {
    const s = hash.replace(/^#?s=/, '').replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return merge(structuredClone(DEFAULTS), JSON.parse(new TextDecoder().decode(bytes)))
  } catch {
    return null
  }
}
