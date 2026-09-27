export type Triple = [number, number, number] // PERT [low, most likely, high]

export type Channel = 'voice' | 'chat' | 'email'
export type BalanceMode = 'priority' | 'floor' | 'prorata' | 'equal'

/** How delivered service is computed. Required FTE is always sized with Erlang C. */
export interface ServiceModel {
  model: 'A' | 'C' // A: customers abandon after an average patience; C: nobody abandons
  patience: { voice: number; chat: number } // mean seconds before a waiting customer gives up (Erlang A)
  redialRate: number // share of abandoned contacts that try again next week (0–1)
  abandonCap: number // worst voice/chat abandonment above this caps the week at BBB (above 2× at CCC)
}

/** How a short week's capacity is shared between channels. */
export interface Balance {
  mode: BalanceMode
  order: Channel[] // priority order (priority mode; floor mode uses it without email)
  emailFloor: number // floor mode: share of this week's email arrival hours guaranteed first (0–1)
}

export type Status = 'default' | 'estimated' | 'confirmed'

/** One entry of the assumption register: how sure we are of an input, and who said so. */
export interface Assumption {
  range?: Triple // [low, likely, high]; absent for structured inputs (waves, step-downs, targets)
  status: Status // default = not asked yet (wide generic range); estimated = someone's range; confirmed = signed off
  owner?: string
  note?: string
}

/** A project-specific question that maps to the same inputs as the generic bank. */
export interface ProjectQuestion {
  id: string
  text: string
  sets: string[]
}

export interface Fate { transfer: number; exit: number; replatform: number } // sum 1

/** The team after the announcement: one stock (v1.3) or two, transferees and the release group. */
export interface People {
  split: boolean // false ⇒ one stock with attrition.postMult (v1.3 behaviour, byte-identical)
  postMultTransfer: number // attrition multiplier after the announcement, transfer group (≥0.5: transferees can be calmer than baseline)
  postMultRelease: number // …release group (≥1)
  retentionEffect: number // 0–1 reduction of post-announcement attrition on the target group (a lever, no range)
  retentionTarget: 'release' | 'transfer' | 'both'
}

/** The book of business described by shares, so its departures can be derived rather than typed in. */
export interface Book {
  mode: 'manual' | 'book' // manual ⇒ v1.3 step-downs, runoff and waves untouched
  contractMix: { fixed: number; evergreen: number; tfc: number } // shares of workload, sum 1 (tfc = rolling with termination for convenience)
  fixedExpiry: [number, number] // weeks from week 0 over which fixed-term work expires (uniform)
  healthMix: { green: number; amber: number; red: number } // shares of workload, sum 1
  priors: { green: Fate; amber: Fate; red: Fate } // fate probabilities by relationship health
  exitNotice: { evergreen: Triple; tfc: Triple } // weeks after the freeze end, PERT
  replatformOffset: Triple // weeks after the freeze end, PERT
  waves: Wave[] // pct = share of TRANSFERRING work per wave (sum ≤ 1; the remainder transfers at the last wave)
  waveSlip: Triple // weeks added to every wave (PERT); 0/0/0 = none
  granularity: number // K client-equivalents sampled per Monte Carlo draw (5–200)
}

export interface Wave {
  weeksAfterFreeze: number // cutover week, counted from the end of the freeze
  pct: number // 0–1 share of the book moved out (and the same share of staff); waves summing to 1 = fully migrated
}

export interface StepDown {
  week: number
  pct: number // 0–1 share of the existing book removed that week
}

/** A period of extra shrinkage, e.g. summer holidays: +pts on top of base shrinkage for `weeks` weeks from `startWeek`. */
export interface ShrinkSpike {
  startWeek: number
  weeks: number
  pts: number // 0–0.5 added to base shrinkage
  label?: string
}

export interface Inputs {
  horizonWeeks: number
  channels: {
    voice: { volume: number; aht: number; slTarget: number; slSeconds: number }
    chat: { volume: number; aht: number; slTarget: number; slSeconds: number; concurrency: number }
    email: { volume: number; aht: number; targetDays: number }
  }
  pool: { fte: number; shrinkage: number; paidHours: number; openHours: number }
  seasonality: { spikes: ShrinkSpike[] } // known periods of extra shrinkage (holidays); reduce available hours only
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
  balance: Balance
  service: ServiceModel
  people: People
  book: Book
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
  }
  assumptions: Record<string, Assumption> // keyed by input path (see questions.ts PATH_META); drives the Monte Carlo
  projectQuestions: ProjectQuestion[]
}

export type Phase = 'pre' | 'freeze' | 'post'

export interface InteractiveWeek {
  volume: number
  scored: boolean // false when volume is a sliver of baseline
  sl: number // NaN when not scored
  need: number // FTE-hours of productive time needed at target
  given: number // productive hours allocated
  unstable: boolean // allocated agents ≤ offered load in some bucket (Erlang C only)
  abandonRate: number // share of offered contacts that give up (0 under Erlang C); NaN when not scored
  abandoned: number // contacts that gave up this week
  retriesIn: number // contacts added this week by earlier abandoners redialling
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
  seasonalPts: number // extra shrinkage from seasonality this week
  prodHours: number // in-house productive hours after shrink, surge and training
  borrowedUsedHours: number
  borrowedIdleHours: number
  inHouseIdleHours: number // productive hours with nothing to do (no voice/chat need in a bucket, email clear)
  fteAvail: number
  fteReq: number
  utilisation: number
  groups?: { transfer: number; release: number } // heads by group after the announcement (people.split only)
  voice: InteractiveWeek
  chat: InteractiveWeek
  email: EmailWeek
  meetsAll: boolean
  cappedByAbandonment: boolean // Erlang A: the abandonment cap lowered this week's grade
  score: number // 0–1, feeds the AAA–D- grade
}

export interface Flows {
  start: number
  hired: number
  attritionPre: number
  attritionFreeze: number
  attritionPost: number
  attritionPostTransfer?: number // people.split: part of attritionPost from the transfer group
  attritionPostRelease?: number // people.split: part of attritionPost from the release group
  moved: number
  released: number
  end: number
}

/** Every intermediate the engine computed for one week (RunOptions.traceWeek). */
export interface WeekTrace {
  week: number
  phase: Phase
  headcount: {
    start: number; moved: number; attritionRate: number; attritionMultiplier: number; lost: number; hired: number; released: number; end: number
    // people.split, after the announcement: the rates the engine actually used, per group
    transferGroup?: number; releaseGroup?: number; transferShareAtSplit?: number
    transferRate?: number; releaseRate?: number; transferMultiplier?: number; releaseMultiplier?: number
    retentionEffect?: { transfer: number; release: number }; lostTransfer?: number; lostRelease?: number
  }
  hours: { paidHoursPerHead: number; shrinkage: number; surgePts: number; seasonalPts: number; effectiveShrinkage: number; grossProductive: number; trainingHours: number; productive: number }
  borrowed: { active: boolean; fte: number; ahtPenalty: number; homeEquivalentHours: number; usedHours: number; idleHours: number }
  buckets: {
    name: string
    volumeShare: number
    hourShare: number
    allocShare: number
    openHours: number
    voice: { offeredErlangs: number; needAgents: number; sizingNeedAgents: number; targetAgents: number; agentsBeforeSpare: number; agentsFinal: number; serviceLevel: number; abandonRate: number }
    chat: { offeredErlangs: number; needAgents: number; sizingNeedAgents: number; targetAgents: number; agentsBeforeSpare: number; agentsFinal: number; serviceLevel: number; abandonRate: number }
    inHouseAgentsAvailable: number
    borrowedAgentsAvailable: number
  }[]
  email: { arrivalHours: number; backlogIn: number; need: number; floorHours: number; targetHours: number; workedBeforeTopUp: number; topUpHours: number; capacityHours: number; workedHours: number; backlogOut: number; dailyArrivalHours: number; backlogDays: number; targetDays: number; timeliness: number }
  balance: { mode: BalanceMode; order: Channel[]; emailFloor: number; ratio: number | null; attainment: number | null; fellBackToProrata: boolean; iterations: number; borrowedHoursByChannel: { voice: number; chat: number; email: number }; inHouseIdleHours: number }
  required: { bucketBindHours: number; interactiveNeedHours: number; emailArrivalHours: number; excessBacklogHours: number; requiredHours: number; fteRequired: number; fteAvailable: number }
  service: { model: 'A' | 'C'; patience: { voice: number; chat: number }; redialRate: number; retriesIn: { voice: number; chat: number }; abandoned: { voice: number; chat: number }; retriesOut: { voice: number; chat: number } }
  grade: { meetsAll: boolean; attainment: { voice: number; chat: number; email: number }; worstAttainment: number; cover: number; unstable: boolean; worstAbandonRate: number; abandonCap: number; scoreBeforeCap: number; score: number }
}

export interface RunResult {
  trace?: WeekTrace
  weeks: WeekResult[]
  flows: Flows
  emailBacklogMovedHours: number // email backlog that left with the waves
  freezeStart: number
  freezeEnd: number
  waveWeeks: number[]
  warnings: string[]
  book?: BookCurve // book mode: the departure curve the run used (expected, or the drawn staircase in a Monte Carlo)
}

/** A departure curve for the book: shares of the week-0 book, per week. */
export interface BookCurve {
  remaining: number[] // book still at the source during week w (after that week's departures)
  transferLeaving: number[] // share of the week-0 book transferring (moving staff) at the start of week w
  exitLeaving: number[] // share leaving because the client exits
  replatformLeaving: number[] // share leaving because the work is re-platformed
  impliedFates: Fate // expected fate shares after the late-exit rule
  transferShareAtAnnouncement: number // τ: share of the book still here at the announcement that will transfer
}
