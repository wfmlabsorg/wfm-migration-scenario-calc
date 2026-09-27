// Synthetic demonstration scenario, no real organisation's data. Its shape follows a typical
// travel-counsellor team in a country exit: a 100-FTE blended team handling phone and email
// (email standing in for all deferrable work, including offline transactions), no chat,
// 10-minute handle times, and a team that starts about 6% short, with both channels sharing
// the shortfall. Then a 14-week consultation freeze with no backfill; about a quarter of the
// work leaving with clients who won't migrate (step-downs) plus a tenth moving to another
// internal platform; then three migration waves. Volumes were calibrated so week 0 has about
// 6% less available than required FTE. (The pre-v1.4.1 demo is kept in tests/fixtures.)
import { defaultRegister } from './register'
import type { Inputs } from './types'

export const DEFAULTS: Inputs = {
  horizonWeeks: 39,
  channels: {
    voice: { volume: 4200, aht: 600, slTarget: 0.8, slSeconds: 60 },
    chat: { volume: 0, aht: 600, slTarget: 0.8, slSeconds: 60, concurrency: 2 }, // no chat channel in this team
    email: { volume: 12600, aht: 600, targetDays: 1 }, // email and other deferrable work
  },
  pool: { fte: 100, shrinkage: 0.25, paidHours: 37.5, openHours: 55 },
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
  service: { model: 'A', patience: { voice: 180, chat: 300 }, redialRate: 0.4, abandonCap: 0.1 }, // patience and redial are estimates
  people: { split: false, postMultTransfer: 1.2, postMultRelease: 3.0, retentionEffect: 0, retentionTarget: 'release' },
  book: {
    mode: 'manual',
    contractMix: { fixed: 0.5, evergreen: 0.3, tfc: 0.2 },
    fixedExpiry: [0, 52],
    healthMix: { green: 0.6, amber: 0.3, red: 0.1 },
    priors: {
      green: { transfer: 0.85, exit: 0.1, replatform: 0.05 },
      amber: { transfer: 0.65, exit: 0.25, replatform: 0.1 },
      red: { transfer: 0.35, exit: 0.55, replatform: 0.1 },
    },
    exitNotice: { evergreen: [8, 13, 26], tfc: [4, 6, 13] },
    replatformOffset: [4, 8, 16],
    waves: [
      { weeksAfterFreeze: 6, pct: 0.33 },
      { weeksAfterFreeze: 12, pct: 0.33 },
      { weeksAfterFreeze: 18, pct: 0.34 },
    ],
    waveSlip: [0, 0, 0],
    granularity: 40,
  },
  balance: { mode: 'equal', order: ['voice', 'chat', 'email'], emailFloor: 0.9 },
  borrowed: { fte: 0, startWeek: 8, endWeek: 38, ahtPenalty: 1.2, eligible: { voice: true, chat: true, email: true } },
  uncertainty: { enabled: false, draws: 1000, seed: 20260926 },
  assumptions: {}, // filled below: every generic question starts unanswered
  projectQuestions: [],
}

DEFAULTS.assumptions = defaultRegister(DEFAULTS)

export function cloneDefaults(): Inputs {
  return structuredClone(DEFAULTS)
}
