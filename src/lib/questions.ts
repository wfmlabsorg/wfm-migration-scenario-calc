// The generic question bank. Each question is something a planner has to pin someone down on;
// each answer sets one or more model inputs, and its uncertainty is a range (low, likely, high).
// Unanswered questions carry a deliberately wide default range, so answering them visibly
// narrows the forecast bands.
import type { Triple } from './types'

export type Unit = 'weeks' | 'pct' | 'x' | 'sec' | 'hours' | 'contacts' | 'fte'

export interface PathMeta {
  label: string
  unit: Unit
  integer?: boolean
  min: number
  max: number
  /** Range used while the question is unanswered, around the current (likely) value. */
  defaultRange: (likely: number) => Triple
  /** The value is a volume or headcount: it never leaves in a shape card except as a share. */
  scaled?: boolean
}

const rel = (lo: number, hi: number) => (x: number): Triple => [x * lo, x, x * hi]
const add = (lo: number, hi: number) => (x: number): Triple => [x + lo, x, x + hi]

/** Every input the register can hold a range for. Structured inputs (waves, step-downs) carry a status only. */
export const PATH_META: Record<string, PathMeta> = {
  'freeze.startWeek': { label: 'Freeze start (week)', unit: 'weeks', integer: true, min: 0, max: 77, defaultRange: add(-2, 4) },
  'freeze.length': { label: 'Consultation / freeze length', unit: 'weeks', integer: true, min: 0, max: 77, defaultRange: (x) => [Math.round(x * 0.7), x, Math.round(x * 1.8)] },
  'after.noticeWeeks': { label: 'Notice before releases', unit: 'weeks', integer: true, min: 0, max: 26, defaultRange: add(-2, 6) },
  'attrition.annual': { label: 'Base annual attrition', unit: 'pct', min: 0, max: 1, defaultRange: rel(0.75, 1.4) },
  'attrition.tensionMult': { label: 'Attrition during the freeze', unit: 'x', min: 1, max: 6, defaultRange: (x) => [1, x, x * 1.6] },
  'attrition.postMult': { label: 'Attrition after the announcement', unit: 'x', min: 1, max: 8, defaultRange: (x) => [Math.max(1, x * 0.6), x, x * 1.6] },
  'after.surgePts': { label: 'Absence surge after the announcement', unit: 'pct', min: 0, max: 0.3, defaultRange: (x) => [0, x, Math.max(x * 2.5, x + 0.06)] },
  'after.surgeWeeks': { label: 'Weeks the surge lasts', unit: 'weeks', integer: true, min: 0, max: 52, defaultRange: rel(0.5, 2) },
  'after.trainingHours': { label: 'Training hours per transferee', unit: 'hours', min: 0, max: 200, defaultRange: rel(0.5, 2) },
  'pool.shrinkage': { label: 'Shrinkage', unit: 'pct', min: 0, max: 0.6, defaultRange: add(-0.04, 0.06) },
  'demand.runoffPctWeek': { label: 'Weekly runoff of the existing book', unit: 'pct', min: 0, max: 0.2, defaultRange: (x) => [0, x, Math.max(x * 2, 0.01)] },
  'demand.intakePct': { label: 'Share of runoff replaced by new work', unit: 'pct', min: 0, max: 1.5, defaultRange: rel(0.5, 1.2) },
  'channels.voice.volume': { label: 'Voice contacts per week', unit: 'contacts', min: 0, max: 500000, defaultRange: rel(0.92, 1.08), scaled: true },
  'channels.chat.volume': { label: 'Chats per week', unit: 'contacts', min: 0, max: 500000, defaultRange: rel(0.92, 1.08), scaled: true },
  'channels.email.volume': { label: 'Emails per week', unit: 'contacts', min: 0, max: 500000, defaultRange: rel(0.92, 1.08), scaled: true },
  'channels.voice.aht': { label: 'Voice handle time', unit: 'sec', min: 30, max: 3600, defaultRange: rel(0.9, 1.2) },
  'channels.chat.aht': { label: 'Chat handle time', unit: 'sec', min: 30, max: 7200, defaultRange: rel(0.9, 1.2) },
  'channels.email.aht': { label: 'Email handle time', unit: 'sec', min: 30, max: 7200, defaultRange: rel(0.9, 1.2) },
  'service.patience.voice': { label: 'Caller patience', unit: 'sec', min: 5, max: 3600, defaultRange: rel(0.5, 2) },
  'service.patience.chat': { label: 'Chat customer patience', unit: 'sec', min: 5, max: 3600, defaultRange: rel(0.5, 2) },
  'service.redialRate': { label: 'Share of extra abandoners who redial', unit: 'pct', min: 0, max: 1, defaultRange: (x) => [Math.max(0, x - 0.2), x, Math.min(1, x + 0.3)] },
  'borrowed.fte': { label: 'Borrowed FTE', unit: 'fte', min: 0, max: 2000, defaultRange: rel(0.5, 1), scaled: true },
  'borrowed.ahtPenalty': { label: 'Borrowed staff slowdown', unit: 'x', min: 1, max: 3, defaultRange: (x) => [Math.max(1, x - 0.1), x, x + 0.3] },
}

/** Structured inputs that carry a status and note but no drawn range (v1.3). */
export const STRUCTURED = ['after.waves', 'demand.stepDowns', 'freeze.backfillBefore', 'channels.targets'] as const

export interface Question {
  id: string
  group: 'Timing' | 'People' | 'Demand' | 'Service'
  text: string
  why: string
  sets: string[]
  hint?: string
}

export const QUESTIONS: Question[] = [
  { id: 'T1', group: 'Timing', text: 'When does the freeze (consultation) start?', why: 'Backfill stops and tension attrition begins then.', sets: ['freeze.startWeek'] },
  { id: 'T2', group: 'Timing', text: 'How long will consultation last: shortest, likely, longest?', why: 'The longer the freeze, the more staff are lost before any work leaves. Usually the widest range.', sets: ['freeze.length'], hint: '"About 4 months, could be 6" → 13 / 17 / 26 weeks.' },
  { id: 'T3', group: 'Timing', text: 'When does each wave cut over, and what share of the work moves in each?', why: 'Waves remove work and staff together; training hours come off the floor before each one.', sets: ['after.waves'] },
  { id: 'T4', group: 'Timing', text: 'How much notice must be given before surplus staff are released?', why: 'Sets when releases can start.', sets: ['after.noticeWeeks'] },
  { id: 'P1', group: 'People', text: 'What is normal annual attrition for this team?', why: 'The baseline every multiplier scales.', sets: ['attrition.annual'] },
  { id: 'P2', group: 'People', text: 'How much does attrition rise during the freeze?', why: 'People leave while they cannot be replaced.', sets: ['attrition.tensionMult'], hint: 'As a multiple of normal: 1.5 means half as much again.' },
  { id: 'P3', group: 'People', text: 'How much does attrition rise after the announcement?', why: 'Staff with a known end date look for jobs.', sets: ['attrition.postMult'] },
  { id: 'P4', group: 'People', text: 'How much extra absence follows the announcement, and for how long?', why: 'Sickness and leave rise; productive hours fall without anyone leaving.', sets: ['after.surgePts', 'after.surgeWeeks'] },
  { id: 'P5', group: 'People', text: 'How many training hours does each transferee need before their wave?', why: 'Time off the floor exactly when the team is thinnest.', sets: ['after.trainingHours'] },
  { id: 'P6', group: 'People', text: 'What is total shrinkage today?', why: 'Every hour of capacity is net of it.', sets: ['pool.shrinkage'] },
  { id: 'P7', group: 'People', text: 'Are leavers backfilled before the freeze starts?', why: 'Decides the headcount the freeze starts from.', sets: ['freeze.backfillBefore'] },
  { id: 'D1', group: 'Demand', text: 'How fast does the existing book run off, and from when?', why: 'Work leaving early offsets staff leaving early.', sets: ['demand.runoffPctWeek'] },
  { id: 'D2', group: 'Demand', text: 'Which contracts end or re-platform, and in which weeks (share of the book)?', why: 'Step-downs remove work that is not transferred.', sets: ['demand.stepDowns'] },
  { id: 'D3', group: 'Demand', text: 'Is new work still being taken on, and how much of the runoff does it replace?', why: 'Intake keeps demand up while staff leave.', sets: ['demand.intakePct'] },
  { id: 'D4', group: 'Demand', text: 'How good is the volume forecast for each channel?', why: 'Forecast error moves the whole curve.', sets: ['channels.voice.volume', 'channels.chat.volume', 'channels.email.volume'], hint: 'Typical weekly error: ±5–10%.' },
  { id: 'S1', group: 'Service', text: 'What are handle times per channel, and do they rise during the transition?', why: 'Handle time converts contacts into hours.', sets: ['channels.voice.aht', 'channels.chat.aht', 'channels.email.aht'] },
  { id: 'S2', group: 'Service', text: 'What service targets apply (answer time, turnaround)?', why: 'Policy: usually confirmed, not estimated.', sets: ['channels.targets'] },
  { id: 'S3', group: 'Service', text: 'How long do customers wait before giving up, and how many try again?', why: 'Erlang A: patience decides abandonment in overloaded weeks.', sets: ['service.patience.voice', 'service.patience.chat', 'service.redialRate'] },
  { id: 'S4', group: 'Service', text: 'Is capacity available to borrow, how much, and how much slower is it?', why: 'Borrowed staff fill the gap only on channels they can take.', sets: ['borrowed.fte', 'borrowed.ahtPenalty'] },
]

export const STATUS_LABEL = { default: 'Not asked', estimated: 'Estimated', confirmed: 'Confirmed' } as const
