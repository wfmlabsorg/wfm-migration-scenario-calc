import { describe, expect, test } from 'bun:test'
import { applyChanges, PATHS } from '../src/agent/schema'
import { TOOL_DEFS } from '../src/agent/toolDefs'
import { AgentTools } from '../src/agent/tools'
import { addTo, costUsd, dayKey, gate, LIMITS, validateRequest, withCacheBreakpoint, type CounterStore } from '../src/agent/relay'
import { DEFAULTS } from '../src/lib/defaults'
import { run } from '../src/lib/engine'
import { simulate } from '../src/lib/montecarlo'
import type { Inputs } from '../src/lib/types'

function host(start: Inputs = structuredClone(DEFAULTS)) {
  let inputs = start
  const applied: string[] = []
  return {
    applied,
    get inputs() {
      return inputs
    },
    tools: new AgentTools({
      getInputs: () => inputs,
      applyInputs: (next, label) => {
        inputs = next
        applied.push(label)
      },
      monteCarlo: async (i, draws) => simulate(i, draws, 7),
    }),
  }
}

describe('explain_week reconciles to the engine', () => {
  test('every figure in the trace matches the week result', () => {
    for (const week of [0, 10, 18, 25, 33]) {
      const r = run(DEFAULTS, { traceWeek: week })
      const t = r.trace!
      const w = r.weeks[week]
      expect(t.headcount.end).toBeCloseTo(w.heads, 9)
      expect(t.headcount.start - t.headcount.moved - t.headcount.lost + t.headcount.hired - t.headcount.released).toBeCloseTo(t.headcount.end, 9)
      expect(t.hours.productive).toBeCloseTo(w.prodHours, 9)
      expect(Math.max(0, t.hours.grossProductive - t.hours.trainingHours)).toBeCloseTo(t.hours.productive, 9)
      expect(t.required.fteRequired).toBeCloseTo(w.fteReq, 9)
      expect(t.required.fteAvailable).toBeCloseTo(w.fteAvail, 9)
      const volShare = DEFAULTS.profile.volumeShare
      if (w.voice.scored) expect(t.buckets.reduce((s, b, k) => s + volShare[k] * b.voice.serviceLevel, 0)).toBeCloseTo(w.voice.sl, 9)
      if (w.chat.scored) expect(t.buckets.reduce((s, b, k) => s + volShare[k] * b.chat.serviceLevel, 0)).toBeCloseTo(w.chat.sl, 9)
      expect(t.email.backlogOut).toBeCloseTo(w.email.backlogHours, 9)
      expect(t.email.workedHours).toBeCloseTo(w.email.workedHours, 9)
      if (Number.isFinite(w.score)) expect(t.grade.score).toBeCloseTo(w.score, 9)
      expect(t.buckets.reduce((s, b) => s + (b.voice.agentsFinal + b.chat.agentsFinal) * b.openHours, 0)).toBeCloseTo(w.voice.given + w.chat.given, 6)
    }
  })
  test('trace is only produced when asked', () => {
    expect(run(DEFAULTS).trace).toBeUndefined()
  })
})

describe('change validation', () => {
  test('applies allowed paths and booleans', () => {
    const next = applyChanges(DEFAULTS, { changes: [{ path: 'borrowed.fte', value: 15 }, { path: 'demand.intakeOn', value: 1 }] })
    expect(next.borrowed.fte).toBe(15)
    expect(next.demand.intakeOn).toBe(true)
    expect(DEFAULTS.borrowed.fte).toBe(0) // original untouched
  })
  test('rejects unknown paths, out-of-range values, fractional integers and bad booleans', () => {
    expect(() => applyChanges(DEFAULTS, { changes: [{ path: 'pool.fte.__proto__', value: 1 }] })).toThrow(/Unknown input/)
    expect(() => applyChanges(DEFAULTS, { changes: [{ path: 'uncertainty.seed', value: 1 }] })).toThrow(/Unknown input/)
    expect(() => applyChanges(DEFAULTS, { changes: [{ path: 'pool.shrinkage', value: 0.9 }] })).toThrow(/between/)
    expect(() => applyChanges(DEFAULTS, { changes: [{ path: 'freeze.endWeek', value: 12.5 }] })).toThrow(/whole number/)
    expect(() => applyChanges(DEFAULTS, { changes: [{ path: 'demand.intakeOn', value: 0.5 }] })).toThrow(/0 or 1/)
    expect(() => applyChanges(DEFAULTS, { waves: [{ weeksAfterFreeze: 2, pct: 1.5 }] })).toThrow(/pct/)
  })
  test('every allowed path exists in the inputs and every tool enum matches', () => {
    for (const p of PATHS) {
      const v = p.path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], DEFAULTS)
      expect(v === undefined).toBe(false)
    }
    const run_ = TOOL_DEFS.find((t) => t.name === 'run_scenario')!
    const e = (run_.input_schema.properties.changes as { items: { properties: { path: { enum: string[] } } } }).items.properties.path.enum
    expect(e).toEqual(PATHS.map((p) => p.path))
  })
  test('tool schemas are strict-shaped', () => {
    for (const t of TOOL_DEFS) {
      expect(t.strict).toBe(true)
      expect(t.input_schema.additionalProperties).toBe(false)
      expect([...t.input_schema.required].sort()).toEqual(Object.keys(t.input_schema.properties).sort())
    }
  })
})

describe('tools', () => {
  test('run_scenario equals run() with the same changes and does not touch the screen', async () => {
    const h = host()
    const out = JSON.parse(await h.tools.execute('run_scenario', { label: 'b20', changes: [{ path: 'borrowed.fte', value: 20 }], waves: [], step_downs: [] }))
    const direct = run(applyChanges(DEFAULTS, { changes: [{ path: 'borrowed.fte', value: 20 }] }))
    expect(out.weekly.rows.length).toBe(direct.weeks.length)
    expect(out.weekly.rows[25][4]).toBeCloseTo(direct.weeks[25].fteReq, 2)
    expect(h.inputs.borrowed.fte).toBe(0)
  })
  test('explain_week works on a labelled run and on screen', async () => {
    const h = host()
    await h.tools.execute('run_scenario', { label: 'x', changes: [{ path: 'borrowed.fte', value: 10 }], waves: [], step_downs: [] })
    const a = JSON.parse(await h.tools.execute('explain_week', { label: 'x', week: 20 }))
    const b = JSON.parse(await h.tools.execute('explain_week', { label: '', week: 20 }))
    expect(a.borrowed.fte).toBe(10)
    expect(b.borrowed.fte).toBe(0)
    await expect(h.tools.execute('explain_week', { label: 'x', week: 999 })).rejects.toThrow(/week must be/)
    await expect(h.tools.execute('explain_week', { label: 'nope', week: 1 })).rejects.toThrow(/No scenario/)
  })
  test('run_scenario can switch the balancing policy, and rejects invalid ones', async () => {
    const h = host()
    const pr = JSON.parse(await h.tools.execute('run_scenario', { label: 'pr', changes: [], waves: [], step_downs: [], balance: [] }))
    const fl = JSON.parse(await h.tools.execute('run_scenario', { label: 'fl', changes: [], waves: [], step_downs: [], balance: [{ mode: 'floor', order: ['voice', 'chat', 'email'], email_floor: 0.9 }] }))
    expect(fl.results.worstEmailBacklogDays).toBeLessThan(pr.results.worstEmailBacklogDays)
    expect(h.inputs.balance.mode).toBe('priority') // the screen is untouched
    await expect(h.tools.execute('run_scenario', { label: 'x', changes: [], waves: [], step_downs: [], balance: [{ mode: 'fair', order: ['voice', 'chat', 'email'], email_floor: 0.5 }] })).rejects.toThrow(/mode/)
    await expect(h.tools.execute('run_scenario', { label: 'x', changes: [], waves: [], step_downs: [], balance: [{ mode: 'priority', order: ['voice', 'voice', 'email'], email_floor: 0.5 }] })).rejects.toThrow(/order/)
    const sw = JSON.parse(await h.tools.execute('sweep', { label: 'fl', path: 'balance.emailFloor', values: [0.5, 0.9] }))
    expect(sw.rows).toHaveLength(2)
  })
  test('the system prompt carries the equations verbatim', async () => {
    const { SYSTEM_PROMPT } = await import('../src/agent/systemPrompt')
    const { EQUATIONS } = await import('../src/lib/equations')
    expect(SYSTEM_PROMPT).toContain(EQUATIONS)
  })
  test('sweep, compare, monte carlo and apply', async () => {
    const h = host()
    const sw = JSON.parse(await h.tools.execute('sweep', { label: '', path: 'borrowed.fte', values: [0, 20, 30] }))
    expect(sw.rows).toHaveLength(3)
    expect(sw.rows[2].weeksBelowTarget.email).toBeLessThan(sw.rows[0].weeksBelowTarget.email)
    await h.tools.execute('run_scenario', { label: 'b30', changes: [{ path: 'borrowed.fte', value: 30 }], waves: [], step_downs: [] })
    const cmp = JSON.parse(await h.tools.execute('compare', { labels: ['', 'b30'] }))
    expect(cmp).toHaveLength(2)
    const mc = JSON.parse(await h.tools.execute('run_monte_carlo', { label: 'b30', draws: 100 }))
    expect(mc.shareOfFuturesWithNoBreach).toBeGreaterThanOrEqual(0)
    const ap = JSON.parse(await h.tools.execute('apply_to_calculator', { label: 'b30' }))
    expect(ap.applied).toBe('b30')
    expect(h.inputs.borrowed.fte).toBe(30)
    expect(h.applied).toEqual(['b30'])
  })
})

describe('relay rules', () => {
  const ok = { messages: [{ role: 'user', content: 'Why does week 20 drop?' }] }
  test('accepts a plain question', () => expect(validateRequest(ok).ok).toBe(true))
  test('refuses anything the server owns', () => {
    for (const k of ['system', 'tools', 'model', 'max_tokens', 'thinking']) expect(validateRequest({ ...ok, [k]: 'x' }).ok).toBe(false)
    expect(validateRequest({ ...ok, extra: 1 }).ok).toBe(false)
  })
  test('refuses bad shapes, wrong roles, long text and server-only blocks', () => {
    expect(validateRequest({ messages: [] }).ok).toBe(false)
    expect(validateRequest({ messages: [{ role: 'assistant', content: 'hi' }] }).ok).toBe(false)
    expect(validateRequest({ messages: [{ role: 'user', content: 'x'.repeat(LIMITS.maxUserTextChars + 1) }] }).ok).toBe(false)
    expect(validateRequest({ messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] }).ok).toBe(false)
    expect(validateRequest({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'server_tool_use' }] }, { role: 'user', content: 'b' }] }).ok).toBe(false)
  })
  test('caps tool rounds per question', () => {
    const msgs: unknown[] = [{ role: 'user', content: 'q' }]
    for (let i = 0; i <= LIMITS.maxToolRounds; i++) {
      msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'get_scenario', input: {} }] })
      msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: '{}' }] })
    }
    expect(validateRequest({ messages: msgs }).ok).toBe(false)
    expect(validateRequest({ messages: msgs.slice(0, 5) }).ok).toBe(true)
  })
  test('cache breakpoint lands on the last block only', () => {
    const m = withCacheBreakpoint([{ role: 'user', content: 'q' }]) as { content: { cache_control?: unknown }[] }[]
    expect(m[0].content[0].cache_control).toEqual({ type: 'ephemeral' })
  })
  test('cost uses Sonnet 5 prices with cache multipliers', () => {
    expect(costUsd({ input_tokens: 1_000_000 })).toBeCloseTo(2, 9)
    expect(costUsd({ output_tokens: 1_000_000 })).toBeCloseTo(10, 9)
    expect(costUsd({ cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.2, 9)
    expect(costUsd({ cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(2.5, 9)
  })
})

describe('quotas and the daily cap', () => {
  function memStore(): CounterStore & { data: Map<string, { value: number; etag: string }> } {
    const data = new Map<string, { value: number; etag: string }>()
    let n = 0
    return {
      data,
      async read(k) { return data.get(k) ?? null },
      async write(k, v, prev) {
        const cur = data.get(k)
        if ((cur && cur.etag !== prev?.etag) || (!cur && prev)) return false
        data.set(k, { value: v, etag: `e${++n}` })
        return true
      },
    }
  }
  test('counters add correctly, including under a lost race', async () => {
    const s = memStore()
    await addTo(s, 'k', 1)
    await addTo(s, 'k', 2.5)
    expect(s.data.get('k')!.value).toBeCloseTo(3.5, 9)
  })
  test('blocks at the daily cap and at the hourly IP quota', async () => {
    const s = memStore()
    const now = new Date('2026-09-26T12:00:00Z')
    expect((await gate(s, 'ip1', now)).ok).toBe(true)
    await addTo(s, dayKey(now), LIMITS.dailyUsd)
    const g = await gate(s, 'ip1', now)
    expect(g.ok).toBe(false)
    if (!g.ok) expect(g.code).toBe('daily_cap')
    const s2 = memStore()
    let last
    for (let i = 0; i <= LIMITS.ipRequestsPerHour; i++) last = await gate(s2, 'ip2', now)
    expect(last!.ok).toBe(false)
    if (last && !last.ok) expect(last.code).toBe('ip_quota')
    expect((await gate(s2, 'ip3', now)).ok).toBe(true) // other visitors unaffected
  })
})
