// Synthetic demonstration scenario, no real organisation's data. Its shape follows a typical
// country-exit migration: a 260-FTE blended team with about 3% headroom; a 14-week consultation
// freeze with no backfill; about a quarter of the work leaving with clients who won't migrate
// (step-downs) plus a tenth moving to another internal platform; then three migration waves.
// Volumes were calibrated so week 0 has about 3% more available than required FTE.
import type { Inputs } from './types'

export const DEFAULTS: Inputs = {
  horizonWeeks: 39,
  channels: {
    voice: { volume: 30820, aht: 360, slTarget: 0.8, slSeconds: 20 },
    chat: { volume: 11140, aht: 600, slTarget: 0.8, slSeconds: 60, concurrency: 2 },
    email: { volume: 13980, aht: 480, targetDays: 1 },
  },
  pool: { fte: 260, shrinkage: 0.32, paidHours: 37.5, openHours: 60 },
  profile: { volumeShare: [0.45, 0.4, 0.15], hourShare: [0.3, 0.45, 0.25], scheduleFit: 0.85 },
  attrition: { annual: 0.14, tensionMult: 1.5, postMult: 2.5 },
  freeze: { startWeek: 2, endWeek: 16, backfillBefore: true },
  demand: {
    runoffPctWeek: 0,
    runoffStartWeek: null,
    stepDowns: [
      { week: 20, pct: 0.08 }, // clients leaving at contract end
      { week: 22, pct: 0.1 }, // work re-platformed internally
      { week: 24, pct: 0.08 },
      { week: 29, pct: 0.09 },
    ],
    intakeOn: false,
    intakePct: 1,
  },
  after: {
    waves: [
      { weeksAfterFreeze: 6, pct: 0.33 },
      { weeksAfterFreeze: 12, pct: 0.33 },
      { weeksAfterFreeze: 18, pct: 0.34 },
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
  borrowed: { fte: 0, startWeek: 8, endWeek: 38, ahtPenalty: 1.2, eligible: { voice: true, chat: true, email: true } },
  uncertainty: {
    enabled: false,
    draws: 1000,
    seed: 20260926,
    freezeLength: [10, 14, 26],
    tensionMult: [1.0, 1.5, 2.5],
    postMult: [1.5, 2.5, 4.0],
    surgePts: [0, 0.04, 0.1],
    runoffPctWeek: [0, 0, 0.01],
  },
}

export function cloneDefaults(): Inputs {
  return structuredClone(DEFAULTS)
}
