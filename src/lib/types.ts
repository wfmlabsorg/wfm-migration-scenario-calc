export type Triple = [number, number, number] // PERT [low, most likely, high]

export interface Wave {
  weeksAfterFreeze: number // cutover week, counted from the end of the freeze
  pct: number // 0–1 share of the book moved out (and the same share of staff); waves summing to 1 = fully migrated
}

export interface StepDown {
  week: number
  pct: number // 0–1 share of the existing book removed that week
}

export interface Inputs {
  horizonWeeks: number
  channels: {
    voice: { volume: number; aht: number; slTarget: number; slSeconds: number }
    chat: { volume: number; aht: number; slTarget: number; slSeconds: number; concurrency: number }
    email: { volume: number; aht: number; targetDays: number }
  }
  pool: { fte: number; shrinkage: number; paidHours: number; openHours: number }
  profile: { volumeShare: Triple; hourShare: Triple; scheduleFit: number }
  attrition: { annual: number; tensionMult: number; postMult: number }
  freeze: { startWeek: number; endWeek: number; backfillBefore: boolean }
  demand: {
    runoffPctWeek: number
    runoffStartWeek: number | null // null = freeze start
    stepDowns: StepDown[]
    intakeOn: boolean
    intakePct: number // 0–1: new book replaces this share of what has run off
  }
  after: {
    waves: Wave[]
    trainingHours: number
    trainingWeeks: number
    surgePts: number
    surgeWeeks: number
    releasesOn: boolean
    noticeWeeks: number
    releaseBuffer: number
    lookaheadWeeks: number
  }
  borrowed: {
    fte: number
    startWeek: number
    endWeek: number
    ahtPenalty: number // ≥1: borrowed staff are this much slower on unfamiliar work
    eligible: { voice: boolean; chat: boolean; email: boolean }
  }
  uncertainty: {
    enabled: boolean
    draws: number
    seed: number
    freezeLength: Triple
    tensionMult: Triple
    postMult: Triple
    surgePts: Triple
    runoffPctWeek: Triple
  }
}

export type Phase = 'pre' | 'freeze' | 'post'

export interface InteractiveWeek {
  volume: number
  scored: boolean // false when volume is a sliver of baseline
  sl: number // NaN when not scored
  need: number // FTE-hours of productive time needed at target
  given: number // productive hours allocated
  unstable: boolean // allocated agents ≤ offered load in some bucket
}

export interface EmailWeek {
  volume: number
  scored: boolean
  arrivalHours: number
  workedHours: number
  backlogHours: number
  backlogDays: number
  timeliness: number // min(1, targetDays / backlogDays); NaN when not scored
}

export interface WeekResult {
  week: number
  phase: Phase
  heads: number
  hired: number
  attrition: number
  moved: number
  released: number
  trainingHours: number
  surgePts: number
  prodHours: number // in-house productive hours after shrink, surge and training
  borrowedUsedHours: number
  borrowedIdleHours: number
  fteAvail: number
  fteReq: number
  utilisation: number
  voice: InteractiveWeek
  chat: InteractiveWeek
  email: EmailWeek
  meetsAll: boolean
  score: number // 0–1, feeds the AAA–D- grade
}

export interface Flows {
  start: number
  hired: number
  attritionPre: number
  attritionFreeze: number
  attritionPost: number
  moved: number
  released: number
  end: number
}

export interface RunResult {
  weeks: WeekResult[]
  flows: Flows
  emailBacklogMovedHours: number // email backlog that left with the waves
  freezeStart: number
  freezeEnd: number
  waveWeeks: number[]
  warnings: string[]
}
