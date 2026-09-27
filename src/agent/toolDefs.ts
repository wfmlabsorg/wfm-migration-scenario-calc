// Tool definitions for the analyst. The server relay pins these (the browser cannot change them);
// the browser executes them against the engine. Ranges are enforced by schema.ts applyChanges.
import { PATH_META } from '../lib/questions'
import { PATHS } from './schema'

const pathEnum = PATHS.map((p) => p.path)

const changesSchema = {
  type: 'array',
  description:
    'Input changes. Each is {path, value}. Booleans use 1 (yes) or 0 (no). Shares and rates are fractions (0.8 = 80%). Empty = no changes.',
  items: {
    type: 'object',
    properties: { path: { type: 'string', enum: pathEnum }, value: { type: 'number' } },
    required: ['path', 'value'],
    additionalProperties: false,
  },
}
const wavesSchema = {
  type: 'array',
  description: 'Replacement wave schedule (max 4). weeksAfterFreeze is a whole number; pct is the share of the book (0–1; shares summing to 1 = fully migrated). Empty = keep the current waves.',
  items: {
    type: 'object',
    properties: { weeksAfterFreeze: { type: 'integer' }, pct: { type: 'number' } },
    required: ['weeksAfterFreeze', 'pct'],
    additionalProperties: false,
  },
}
const stepDownsSchema = {
  type: 'array',
  description: 'Replacement demand step-downs (e.g. contract expiries): week and pct of the existing book removed that week (0–1). Empty = keep the current step-downs.',
  items: {
    type: 'object',
    properties: { week: { type: 'integer' }, pct: { type: 'number' } },
    required: ['week', 'pct'],
    additionalProperties: false,
  },
}
const shrinkSpikesSchema = {
  type: 'array',
  description: 'Replacement seasonal shrinkage spikes (e.g. summer holidays): startWeek (from week 0), weeks, pts = extra shrinkage 0–0.5. Empty = keep the current spikes; to remove them all pass one item with weeks 0.',
  items: {
    type: 'object',
    properties: { startWeek: { type: 'integer' }, weeks: { type: 'integer' }, pts: { type: 'number' } },
    required: ['startWeek', 'weeks', 'pts'],
    additionalProperties: false,
  },
}
const balanceSchema = {
  type: 'array',
  description: 'Replacement channel-balancing policy: 0 or 1 item. mode: priority (order matters; last absorbs the shortfall), floor (email_floor share of email arrivals guaranteed first, then order without email), prorata (every channel the same fraction of its need), equal (every channel the same attainment). order: voice, chat and email once each. Empty = keep the current policy.',
  items: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['priority', 'floor', 'prorata', 'equal'] },
      order: { type: 'array', items: { type: 'string', enum: ['voice', 'chat', 'email'] } },
      email_floor: { type: 'number' },
    },
    required: ['mode', 'order', 'email_floor'],
    additionalProperties: false,
  },
}
const shares = (keys: string[], what: string) => ({
  type: 'object',
  description: `${what}; the shares must sum to 1.`,
  properties: Object.fromEntries(keys.map((k) => [k, { type: 'number' }])),
  required: keys,
  additionalProperties: false,
})
const tripleSchema = (what: string) => ({ type: 'array', description: `${what}: [low, likely, high] in weeks.`, items: { type: 'number' } })
const fateSchema = shares(['transfer', 'exit', 'replatform'], 'Fate probabilities')
const bookProps = {
  contractMix: shares(['fixed', 'evergreen', 'tfc'], 'Shares of workload by contract type (tfc = rolling with termination for convenience)'),
  fixedExpiry: { type: 'array', description: 'Weeks [first, last] over which fixed-term work expires (absolute weeks from week 0).', items: { type: 'integer' } },
  healthMix: shares(['green', 'amber', 'red'], 'Shares of workload by relationship health'),
  priors: { type: 'object', description: 'Fate probabilities by health.', properties: { green: fateSchema, amber: fateSchema, red: fateSchema }, required: ['green', 'amber', 'red'], additionalProperties: false },
  exitNotice: { type: 'object', description: 'Notice rolling clients give after the announcement.', properties: { evergreen: tripleSchema('Rolling'), tfc: tripleSchema('Rolling with convenience clause') }, required: ['evergreen', 'tfc'], additionalProperties: false },
  replatformOffset: tripleSchema('Weeks after the announcement when re-platformed work leaves'),
  waves: { type: 'array', description: 'Transfer waves (max 4): weeksAfterFreeze and pct = share of TRANSFERRING work (sum ≤ 1; remainder on the last wave).', items: { type: 'object', properties: { weeksAfterFreeze: { type: 'integer' }, pct: { type: 'number' } }, required: ['weeksAfterFreeze', 'pct'], additionalProperties: false } },
  waveSlip: tripleSchema('Weeks every wave may slip (0,0,0 = none)'),
  granularity: { type: 'integer', description: 'Client-equivalents sampled per simulated future (5–200; 40 is typical).' },
}
const bookSchema = {
  type: 'array',
  description: 'Replacement book of business (0 or 1 item); turns book mode on. Use this whenever the user describes clients by contract type, health or notice period; never hand-write step_downs for a described book. Empty = keep the current block.',
  items: { type: 'object', properties: { mode: { type: 'string', enum: ['book', 'manual'] }, ...bookProps }, required: ['mode', ...Object.keys(bookProps)], additionalProperties: false },
}
const labelProp = { type: 'string', description: 'Scenario label. Empty string = the scenario currently on screen.' }

export const TOOL_DEFS = [
  {
    name: 'get_scenario',
    description: 'Return the scenario currently on screen: every input, and its headline results (worst week and grade, weeks below target per channel, peak utilisation, largest FTE gap, email backlog, freeze and wave weeks, headcount flows). Call this first in a conversation.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'run_scenario',
    description: 'Run the engine on the on-screen inputs with the given changes applied, WITHOUT changing the screen. Store the run under a short label for later explain_week, compare, sweep, run_monte_carlo or apply_to_calculator. Returns headline results and a compact weekly table.',
    // Not strict: with every tool strict, the compiled grammar exceeds the API's size limit (this
    // tool carries the path enum and four nested schemas). Its input is validated by applyChanges.
    strict: false,
    input_schema: {
      type: 'object',
      properties: { label: { type: 'string', description: 'Short unique label, e.g. "borrow15".' }, changes: changesSchema, waves: wavesSchema, step_downs: stepDownsSchema, balance: balanceSchema, book: bookSchema, shrink_spikes: shrinkSpikesSchema },
      required: ['label', 'changes', 'waves', 'step_downs', 'balance', 'book', 'shrink_spikes'],
      additionalProperties: false,
    },
  },
  {
    name: 'explain_week',
    description: "Return the engine's own arithmetic for one week of a scenario: headcount steps (moves, attrition rate × multiplier, backfill, releases), productive hours (shrinkage, surge, training), borrowed hours, and per intraday bucket the offered load in Erlangs, agents needed at target under the service model and under Erlang C (sizing), agents given before and after spare time, service level and abandon rate; the service model with retries in and out; email capacity, worked hours and backlog; required vs available FTE; and the grade formula with its inputs. Use it to answer any 'why' question.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: { label: labelProp, week: { type: 'integer', description: 'Week number (0-based).' } },
      required: ['label', 'week'],
      additionalProperties: false,
    },
  },
  {
    name: 'sweep',
    description: 'Sensitivity of one input: run the scenario once per value and return, for each, the worst week, its grade, weeks below target per channel, peak utilisation and the largest FTE gap.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        label: labelProp,
        path: { type: 'string', enum: pathEnum },
        values: { type: 'array', items: { type: 'number' }, description: 'Up to 12 values to try.' },
      },
      required: ['label', 'path', 'values'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_monte_carlo',
    description: "Simulate many futures of a scenario, drawing every assumption-register entry that has a range (PERT low/likely/high). Returns the share of futures with no breach, the average band width (how uncertain the forecast still is), the trough range, freeze-end percentiles, and the 10th/50th/90th percentile service per channel at the scenario's worst weeks.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: { label: labelProp, draws: { type: 'integer', description: '100–1000.' } },
      required: ['label', 'draws'],
      additionalProperties: false,
    },
  },
  {
    name: 'compare',
    description: 'Headline results of two or more scenarios side by side (labels from run_scenario; empty string = on screen).',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { labels: { type: 'array', items: { type: 'string' } } },
      required: ['labels'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_assumption',
    description: "Record the user's answer to an assumption question on the on-screen scenario: the likely value becomes the input, low/high its range, and status says how sure it is (estimated = someone's range; confirmed = signed off; default = back to the generic range). Only use values the user gave; never mark something confirmed unless they said it is. Fractions for rates and shares (0.14 = 14%); weeks, seconds, hours or multipliers otherwise. The user sees the change and can undo.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', enum: Object.keys(PATH_META) },
        low: { type: 'number' },
        likely: { type: 'number' },
        high: { type: 'number' },
        status: { type: 'string', enum: ['estimated', 'confirmed', 'default'] },
        owner: { type: 'string', description: 'Who gave or owns the answer (role, not a name); empty if unknown.' },
        note: { type: 'string', description: 'Short note on the answer; empty if none.' },
      },
      required: ['path', 'low', 'likely', 'high', 'status', 'owner', 'note'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_book',
    description: 'Describe the book of business by shares (contract mix, health mix, fate probabilities, notice ranges, waves as shares of transferring work, wave slip) and turn book mode on. With an empty label it goes on screen (the user can undo); with a label it is stored as a scenario like run_scenario. Returns the implied fate shares and the share of the book that will transfer at the announcement. Use it whenever the user describes clients by contract type, health or notice; never hand-write step_downs for a described book.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { label: labelProp, ...bookProps },
      required: ['label', ...Object.keys(bookProps)],
      additionalProperties: false,
    },
  },
  {
    name: 'explain_book',
    description: "The book's expected departure curve: implied fate shares after the late-exit rule, the share transferring at the announcement, what leaves within the horizon by cause, the wave weeks and a 12-point staircase of the book remaining. In manual mode it shows what book mode would give.",
    strict: true,
    input_schema: { type: 'object', properties: { label: labelProp }, required: ['label'], additionalProperties: false },
  },
  {
    name: 'apply_to_calculator',
    description: 'Put a scenario you ran with run_scenario on screen, replacing the current inputs. The user sees what changed and can undo. Only do this when the user asks to see or keep a scenario.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { label: { type: 'string' } },
      required: ['label'],
      additionalProperties: false,
    },
  },
] as const

export type ToolName = (typeof TOOL_DEFS)[number]['name']
