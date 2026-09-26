// Engine version and commit, stamped at build time (vite.config.ts). Falls back safely under bun test.
export const REPO = 'https://github.com/wfmlabsorg/wfm-migration-scenario-calc'

export const ENGINE_VERSION: string = typeof __ENGINE_VERSION__ === 'string' ? __ENGINE_VERSION__ : 'dev'
export const COMMIT: string = typeof __COMMIT__ === 'string' ? __COMMIT__ : 'unknown'
export const SHORT = COMMIT === 'unknown' ? 'unknown' : COMMIT.slice(0, 7)

export const codeUrl = (sha: string) => (sha && sha !== 'unknown' ? `${REPO}/tree/${sha}` : REPO)
