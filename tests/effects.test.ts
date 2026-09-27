// React calls whatever an effect returns as its clean-up. An expression-bodied effect
// (useEffect(() => el.scrollIntoView(...), …)) returns the call's value, which newer browsers
// make non-undefined, so the app crashes. Every effect must have a block body or return a function.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : /\.tsx?$/.test(f) ? [join(d, f)] : []))

test('no expression-bodied effects (only block bodies or explicit clean-up functions)', () => {
  const bad: string[] = []
  for (const f of files('src')) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/use(?:Layout)?Effect\(\s*\(\)\s*=>\s*(?![\s{]|\(\)\s*=>)/g)) bad.push(`${f}: ${src.slice(m.index, m.index + 80).replace(/\n/g, ' ')}`)
  }
  expect(bad).toEqual([])
})
