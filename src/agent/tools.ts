// Executes the analyst's tools in the browser against the same engine the page uses.
import { run } from '../lib/engine'
import { scoreToGrade } from '../lib/grade'
import { kpis } from '../lib/kpis'
import type { McBands } from '../lib/montecarlo'
import type { Inputs, RunResult } from '../lib/types'
import { applyChanges, PATHS, type Change } from './schema'
import type { ToolName } from './toolDefs'

/** Round numbers deeply so tool results stay small and readable. */
export function tidy(x: unknown, d = 3): unknown {
  if (typeof x === 'number') return Number.isFinite(x) ? Number(x.toFixed(d)) : null
  if (Array.isArray(x)) return x.map((v) => tidy(v, d))
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, tidy(v, d)]))
  return x
}

export function weeklyTable(r: RunResult) {
  return {
    columns: ['week', 'phase', 'heads', 'fteAvail', 'fteReq', 'voiceSL', 'chatSL', 'emailOnTime', 'backlogDays', 'utilisation', 'grade'],
    rows: r.weeks.map((w) => [
      w.week, w.phase, w.heads, w.fteAvail, w.fteReq, w.voice.sl, w.chat.sl, w.email.timeliness, w.email.backlogDays,
      Number.isFinite(w.utilisation) ? w.utilisation : null, Number.isFinite(w.score) ? scoreToGrade(w.score).grade : '—',
    ]),
  }
}

export interface ToolHost {
  getInputs: () => Inputs
  applyInputs: (next: Inputs, label: string) => void
  monteCarlo: (inputs: Inputs, draws: number) => Promise<McBands>
}

interface StoredRun {
  inputs: Inputs
  result: RunResult
}

export class AgentTools {
  private runs = new Map<string, StoredRun>()
  constructor(private host: ToolHost) {}

  private resolve(label: string): StoredRun {
    if (!label) {
      const inputs = this.host.getInputs()
      return { inputs, result: run(inputs) }
    }
    const r = this.runs.get(label)
    if (!r) throw new Error(`No scenario labelled "${label}". Known: ${[...this.runs.keys()].join(', ') || 'none'}; use "" for the scenario on screen.`)
    return r
  }

  private headline(s: StoredRun) {
    return tidy(kpis(s.inputs, s.result), 2)
  }

  /** Runs one tool call and returns a JSON string for the tool_result. Throws on invalid input. */
  async execute(name: ToolName | string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'get_scenario': {
        const s = this.resolve('')
        return JSON.stringify({ inputs: s.inputs, results: this.headline(s), allowedChangePaths: PATHS.map((p) => `${p.path} [${p.min}–${p.max}]${p.boolean ? ' (0/1)' : ''}`) })
      }
      case 'run_scenario': {
        const label = String(input.label ?? '').trim()
        if (!label) throw new Error('label must be a non-empty string')
        const waves = input.waves as { weeksAfterFreeze: number; pct: number }[]
        const stepDowns = input.step_downs as { week: number; pct: number }[]
        const inputs = applyChanges(this.host.getInputs(), {
          changes: (input.changes as Change[]) ?? [],
          waves: waves?.length ? waves : undefined,
          stepDowns: stepDowns?.length ? stepDowns : undefined,
        })
        const result = run(inputs)
        this.runs.set(label, { inputs, result })
        return JSON.stringify({ label, results: this.headline({ inputs, result }), warnings: result.warnings, weekly: tidy(weeklyTable(result), 3) })
      }
      case 'explain_week': {
        const s = this.resolve(String(input.label ?? ''))
        const week = Number(input.week)
        if (!Number.isInteger(week) || week < 0 || week >= s.inputs.horizonWeeks) throw new Error(`week must be 0–${s.inputs.horizonWeeks - 1}`)
        const r = run(s.inputs, { traceWeek: week })
        return JSON.stringify(tidy(r.trace, 3))
      }
      case 'sweep': {
        const base = this.resolve(String(input.label ?? ''))
        const path = String(input.path)
        const values = (input.values as number[]).slice(0, 12)
        if (!values.length) throw new Error('values must contain at least one number')
        const rows = values.map((value) => {
          const inputs = applyChanges(base.inputs, { changes: [{ path, value }] })
          const k = kpis(inputs, run(inputs))
          return { value, worstWeek: k.worstWeek, worstGrade: k.worstGrade, worstChannel: k.worstChannel, weeksBelowTarget: k.weeksBelowTarget, peakUtilisation: k.peakUtilisation, largestFteGap: k.largestFteGap }
        })
        return JSON.stringify({ path, base: String(input.label ?? '') || 'on screen', rows: tidy(rows, 2) })
      }
      case 'run_monte_carlo': {
        const s = this.resolve(String(input.label ?? ''))
        const draws = Math.min(1000, Math.max(100, Math.round(Number(input.draws) || 500)))
        const b = await this.host.monteCarlo(s.inputs, draws)
        const graded = s.result.weeks.filter((w) => Number.isFinite(w.score)).sort((a, z) => a.score - z.score).slice(0, 3).map((w) => w.week)
        const at = (w: number) => ({
          week: w,
          voice: [b.p10.voice[w], b.p50.voice[w], b.p90.voice[w]],
          chat: [b.p10.chat[w], b.p50.chat[w], b.p90.chat[w]],
          emailOnTime: [b.p10.email[w], b.p50.email[w], b.p90.email[w]],
          shareMeetingAllTargets: b.meetShare[w],
        })
        return JSON.stringify(tidy({
          draws, shareOfFuturesWithNoBreach: b.cleanShare, gradeOfThatShare: scoreToGrade(b.cleanShare).grade,
          freezeEndWeek: b.freezeEnd, uncertaintyRanges: s.inputs.uncertainty, worstWeeksOfMostLikelyRun: graded.map(at),
          note: 'Service arrays are [10th, 50th, 90th] percentile across futures.',
        }, 3))
      }
      case 'compare': {
        const labels = (input.labels as string[]).slice(0, 6)
        return JSON.stringify(labels.map((l) => ({ label: l || 'on screen', results: this.headline(this.resolve(l)) })))
      }
      case 'apply_to_calculator': {
        const label = String(input.label ?? '')
        const s = this.resolve(label)
        if (!label) throw new Error('Give the label of a scenario from run_scenario')
        this.host.applyInputs(structuredClone(s.inputs), label)
        return JSON.stringify({ applied: label, note: 'The scenario is now on screen; the user can undo.' })
      }
      default:
        throw new Error(`Unknown tool ${name}`)
    }
  }
}
