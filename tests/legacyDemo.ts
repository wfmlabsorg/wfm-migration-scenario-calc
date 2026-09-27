// The demo scenario used before v1.4.1 (a 260-FTE voice/chat/email team). Tests that assert
// specific numbers run on it so the golden fixtures stay bit-for-bit; tests/demo.test.ts covers
// the current default scenario.
import type { Inputs } from '../src/lib/types'
import legacy from './fixtures/legacy-demo-inputs.json'

export const DEFAULTS = legacy as unknown as Inputs
