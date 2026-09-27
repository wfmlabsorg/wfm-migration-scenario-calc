// The default balancing policy (strict priority voice → chat → email) must reproduce the engine
// exactly as it was before balancing policies existed (fixture captured at commit f35c00e).
// v1.3 (engine fixes): the `releases` variant was recaptured, because releases now respect this
// week's backlog and retries, and email takes borrowed time first; the other three are untouched.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { DEFAULTS } from '../src/lib/defaults'
import { run } from '../src/lib/engine'
import type { Inputs } from '../src/lib/types'

const golden = JSON.parse(readFileSync('tests/fixtures/golden-v1.1-priority.json', 'utf8'), (_k, v) =>
  typeof v === 'string' && v.startsWith('__') ? Number(v.slice(2)) : v,
) as Record<string, unknown>

const variants: Record<string, (i: Inputs) => void> = {
  demo: () => {},
  borrowedVoiceOnly: (i) => { i.borrowed = { ...i.borrowed, fte: 25, startWeek: 6, endWeek: 30, ahtPenalty: 1.3, eligible: { voice: true, chat: false, email: false } } },
  releases: (i) => { i.after.releasesOn = true; i.after.noticeWeeks = 4; i.borrowed.fte = 10 },
  understaffed: (i) => { i.pool.fte = 200; i.demand.intakeOn = true; i.demand.runoffPctWeek = 0.01 },
}

/** Deep comparison with Object.is on every number; ignores fields added after the snapshot. */
function sameAsGolden(actual: unknown, expected: unknown, path: string, diffs: string[]) {
  if (typeof expected === 'number') {
    if (!Object.is(actual, expected)) diffs.push(`${path}: ${String(actual)} ≠ ${expected}`)
    return
  }
  if (expected && typeof expected === 'object') {
    for (const [k, v] of Object.entries(expected)) sameAsGolden((actual as Record<string, unknown>)?.[k], v, `${path}.${k}`, diffs)
    return
  }
  if (actual !== expected) diffs.push(`${path}: ${String(actual)} ≠ ${String(expected)}`)
}

describe('default policy is bit-for-bit identical to the pre-balancing engine', () => {
  for (const [name, f] of Object.entries(variants))
    test(name, () => {
      const i = structuredClone(DEFAULTS)
      i.service.model = 'C' // the fixture predates Erlang A
      f(i)
      const r = run(i)
      const diffs: string[] = []
      sameAsGolden({ weeks: r.weeks, flows: r.flows, emailBacklogMovedHours: r.emailBacklogMovedHours }, golden[name], name, diffs)
      expect(diffs.slice(0, 5)).toEqual([])
    })
})
