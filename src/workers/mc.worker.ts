// Runs the Monte Carlo off the main thread. Replies first with a quick 250-draw pass, then
// with the full run; the generation id lets the page ignore answers to stale requests.
import { simulate } from '../lib/montecarlo'
import type { Inputs } from '../lib/types'

self.onmessage = (e: MessageEvent<{ inputs: Inputs; gen: number }>) => {
  const { inputs, gen } = e.data
  const full = inputs.uncertainty.draws
  const seed = inputs.uncertainty.seed
  const quick = Math.min(250, full)
  self.postMessage({ gen, done: quick >= full, bands: simulate(inputs, quick, seed) })
  if (quick < full) self.postMessage({ gen, done: true, bands: simulate(inputs, full, seed) })
}
