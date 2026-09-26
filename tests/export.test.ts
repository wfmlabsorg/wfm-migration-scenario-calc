import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULTS } from '../src/lib/defaults'
import { run } from '../src/lib/engine'
import { worstWeek } from '../src/lib/kpis'
import { dossier } from '../src/lib/dossier'
import { EQUATIONS } from '../src/lib/equations'
import { commitOf, decode, toHash } from '../src/lib/share'

describe('versioned permalink', () => {
  test('round-trips the scenario and records the commit', () => {
    const i = structuredClone(DEFAULTS)
    i.borrowed.fte = 17
    const h = toHash(i, 'abc1234')
    expect(decode(`#${h}`)!.borrowed.fte).toBe(17)
    expect(commitOf(`#${h}`)).toBe('abc1234')
  })
  test('old links without a version still open', () => {
    const h = toHash(DEFAULTS).replace(/&v=.*$/, '')
    expect(decode(`#${h}`)).not.toBeNull()
    expect(commitOf(`#${h}`)).toBeNull()
  })
})

describe('scenario dossier', () => {
  const chat = [
    { role: 'user' as const, text: 'Why does week 20 drop?', tools: [] },
    { role: 'assistant' as const, text: 'Because training and attrition coincide.', tools: [{ id: 't1', name: 'explain_week', input: { label: '', week: 20 }, output: '{"week":20}', error: false }] },
  ]
  const r = run(DEFAULTS)
  const md = dossier(DEFAULTS, r, 'https://migration.wfmlabs.com/', chat)
  test('has every section, the permalink, the engine link and the inputs', () => {
    for (const h of ['## 1. Instructions for Claude', '## 2. Headline results', '## 3. Assumptions', '## 4. Approach', '## 5. Equations', '## 6. Worked example', '## 7. Weekly results', '## 8. Analyst conversation', '## 9. Inputs (JSON)'])
      expect(md).toContain(h)
    expect(md).toContain('https://migration.wfmlabs.com/#s=')
    expect(md).toContain('github.com/wfmlabsorg/wfm-migration-scenario-calc')
    expect(md).toContain(EQUATIONS)
    expect(md).toContain('**explain_week**')
    expect(md).toContain('"fte": 260')
    expect(md.length).toBeLessThan(150_000)
  })
  test('without a conversation, the inputs are section 8', () => {
    const m2 = dossier(DEFAULTS, r, 'https://x/')
    expect(m2).not.toContain('Analyst conversation')
    expect(m2).toContain('## 8. Inputs (JSON)')
  })
  test('the worked example uses the engine trace of the worst week', () => {
    const worst = worstWeek(DEFAULTS, r)!
    const t = run(DEFAULTS, { traceWeek: worst.week }).trace!
    expect(md).toContain(`The worst week is **week ${worst.week}**`)
    expect(md).toContain(`= **${t.headcount.end.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}**`)
    expect(md).toContain(`**P = ${t.hours.productive.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h**`)
    expect(md).toContain(`**${t.required.fteRequired.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} FTE**`)
  })
  test('every balancing policy exports', () => {
    for (const mode of ['priority', 'floor', 'prorata', 'equal'] as const) {
      const i = structuredClone(DEFAULTS)
      i.balance.mode = mode
      expect(dossier(i, run(i), 'https://x/').length).toBeGreaterThan(5000)
    }
  })
})

describe('demo scenario shape', () => {
  test('starts healthy, breaks around the announcement, and borrowed capacity shortens the damage', () => {
    const r = run(DEFAULTS)
    expect(r.weeks[0].meetsAll).toBe(true)
    const firstMiss = r.weeks.findIndex((w) => Number.isFinite(w.score) && !w.meetsAll)
    expect(firstMiss).toBeGreaterThan(8)
    expect(firstMiss).toBeLessThan(22)
    const b = structuredClone(DEFAULTS)
    b.borrowed.fte = 20
    const missing = (x: typeof r) => x.weeks.filter((w) => Number.isFinite(w.score) && !w.meetsAll).length
    expect(missing(run(b))).toBeLessThan(missing(r) / 2)
  })
})

describe('no API keys anywhere in the source or the build', () => {
  const roots = ['src', 'netlify', 'tests', 'docs', 'dist', 'public'].filter((d) => existsSync(d))
  const files: string[] = []
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else files.push(p)
    }
  }
  roots.forEach(walk)
  files.push('README.md', 'index.html', 'netlify.toml', 'vite.config.ts')
  test('no sk-ant- key material', () => {
    const pattern = new RegExp('sk-' + 'ant-[A-Za-z0-9_-]{8,}')
    for (const f of files) if (existsSync(f)) expect(pattern.test(readFileSync(f, 'utf8')), f).toBe(false)
  })
})
