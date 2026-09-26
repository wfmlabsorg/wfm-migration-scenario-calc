// Tool definitions for the analyst. The server relay pins these (the browser cannot change them);
// the browser executes them against the engine. Ranges are enforced by schema.ts applyChanges.
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
    strict: true,
    input_schema: {
      type: 'object',
      properties: { label: { type: 'string', description: 'Short unique label, e.g. "borrow15".' }, changes: changesSchema, waves: wavesSchema, step_downs: stepDownsSchema, balance: balanceSchema },
      required: ['label', 'changes', 'waves', 'step_downs', 'balance'],
      additionalProperties: false,
    },
  },
  {
    name: 'explain_week',
    description: "Return the engine's own arithmetic for one week of a scenario: headcount steps (moves, attrition rate × multiplier, backfill, releases), productive hours (shrinkage, surge, training), borrowed hours, and per intraday bucket the offered load in Erlangs, agents needed at target, agents given before and after spare time, and service level; email capacity, worked hours and backlog; required vs available FTE; and the grade formula with its inputs. Use it to answer any 'why' question.",
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
    description: "Simulate many futures of a scenario, drawing the freeze length, attrition effects, absence surge and runoff from the ranges in its uncertainty settings. Returns the share of futures with no breach, freeze-end percentiles, and the 10th/50th/90th percentile service per channel at the scenario's worst weeks.",
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
