import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULTS } from '../src/lib/defaults'
import { run } from '../src/lib/engine'
import { chatToMarkdown } from '../src/lib/exportChat'
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

describe('conversation export', () => {
  test('contains the permalink, the engine link, every tool call and the inputs', () => {
    const md = chatToMarkdown(
      [
        { role: 'user', text: 'Why does week 20 drop?', tools: [] },
        { role: 'assistant', text: 'Because training and attrition coincide.', tools: [{ id: 't1', name: 'explain_week', input: { label: '', week: 20 }, output: '{"week":20}', error: false }] },
      ],
      DEFAULTS, run(DEFAULTS), 'https://migration.wfmlabs.com/',
    )
    expect(md).toContain('https://migration.wfmlabs.com/#s=')
    expect(md).toContain('github.com/wfmlabsorg/wfm-migration-scenario-calc')
    expect(md).toContain('**explain_week**')
    expect(md).toContain('Why does week 20 drop?')
    expect(md).toContain('"fte": 260')
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
