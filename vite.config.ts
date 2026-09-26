import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Stamp the engine version and the git commit into the bundle, so share links and exports can
// point at the exact code that produced a scenario. Netlify provides COMMIT_REF at build time.
function commit(): string {
  if (process.env.COMMIT_REF) return process.env.COMMIT_REF
  try {
    return execSync('git rev-parse HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
}
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  plugins: [react()],
  define: {
    __ENGINE_VERSION__: JSON.stringify(pkg.version),
    __COMMIT__: JSON.stringify(commit()),
  },
})
