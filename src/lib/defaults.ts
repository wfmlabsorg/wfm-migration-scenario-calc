// Synthetic demonstration scenario: a 120-FTE blended team. No real organisation's data.
import type { Inputs } from './types'

export const DEFAULTS: Inputs = {
  horizonWeeks: 39,
  channels: {
    voice: { volume: 11900, aht: 360, slTarget: 0.8, slSeconds: 20 },
    chat: { volume: 4300, aht: 600, slTarget: 0.8, slSeconds: 60, concurrency: 2 },
    email: { volume: 5400, aht: 480, targetDays: 1 },
  },
  pool: { fte: 120, shrinkage: 0.32, paidHours: 37.5, openHours: 60 },
  profile: { volumeShare: [0.45, 0.4, 0.15], hourShare: [0.3, 0.45, 0.25], scheduleFit: 0.85 },
  attrition: { annual: 0.18, tensionMult: 1.5, postMult: 2.5 },
  freeze: { startWeek: 2, endWeek: 14, backfillBefore: true },
  demand: { runoffPctWeek: 0.005, runoffStartWeek: null, stepDowns: [], intakeOn: false, intakePct: 1 },
  after: {
    waves: [
      { weeksAfterFreeze: 4, pct: 0.3 },
      { weeksAfterFreeze: 10, pct: 0.3 },
      { weeksAfterFreeze: 16, pct: 0.4 },
    ],
    trainingHours: 24,
    trainingWeeks: 4,
    surgePts: 0.04,
    surgeWeeks: 12,
    releasesOn: false,
    noticeWeeks: 6,
    releaseBuffer: 0.05,
    lookaheadWeeks: 4,
  },
  borrowed: { fte: 0, startWeek: 10, endWeek: 38, ahtPenalty: 1.2, eligible: { voice: true, chat: true, email: true } },
  uncertainty: {
    enabled: false,
    draws: 1000,
    seed: 20260926,
    freezeLength: [8, 12, 24],
    tensionMult: [1.0, 1.5, 2.5],
    postMult: [1.5, 2.5, 4.0],
    surgePts: [0, 0.04, 0.1],
    runoffPctWeek: [0, 0.005, 0.02],
  },
}

export function cloneDefaults(): Inputs {
  return structuredClone(DEFAULTS)
}
