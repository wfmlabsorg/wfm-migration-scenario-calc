// Executes the analyst's tools in the browser against the same engine the page uses.
import { bookWaves, expectedBook } from '../lib/book'
import { run } from '../lib/engine'
import { scoreToGrade } from '../lib/grade'
import { kpis } from '../lib/kpis'
import { QUESTIONS } from '../lib/questions'
import { activePath, recordAnswer, requirementMet, statusCounts } from '../lib/register'
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
    columns: ['week', 'phase', 'heads', 'fteAvail', 'fteReq', 'voiceSL', 'voiceAbandon', 'chatSL', 'chatAbandon', 'emailOnTime', 'backlogDays', 'utilisation', 'grade'],
    rows: r.weeks.map((w) => [
      w.week, w.phase, w.heads, w.fteAvail, w.fteReq, w.voice.sl, w.voice.abandonRate, w.chat.sl, w.chat.abandonRate, w.email.timeliness, w.email.backlogDays,
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
  private pending: { base: Inputs; inputs: Inputs } | null = null
  constructor(private host: ToolHost) {}

  /** The on-screen scenario, including changes this turn applied that the page has not rendered yet. */
  private screen(): Inputs {
    const now = this.host.getInputs()
    return this.pending && now === this.pending.base ? this.pending.inputs : now
  }

  private show(next: Inputs, label: string) {
    this.pending = { base: this.host.getInputs(), inputs: next }
    this.host.applyInputs(next, label)
  }

  private resolve(label: string): StoredRun {
    if (!label) {
      const inputs = this.screen()
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
        const open = QUESTIONS.filter((q) => requirementMet(s.inputs, q.requires) && q.sets.some((p) => (s.inputs.assumptions[p]?.status ?? 'default') === 'default')).map((q) => `${q.id}: ${q.text}`)
        const modes = {
          departures: s.inputs.book.mode === 'book' ? 'book of business (contract and health mix, fate priors, notice ranges, waves as shares of transferring work)' : 'manual (runoff, step-downs, waves as shares of the book)',
          team: s.inputs.people.split ? 'split at the announcement into transfer and release groups' : 'one stock (attrition.postMult after the announcement)',
        }
        return JSON.stringify({
          inputs: s.inputs, results: this.headline(s), modes,
          register: { counts: statusCounts(s.inputs), openQuestions: open, projectQuestions: s.inputs.projectQuestions },
          allowedChangePaths: PATHS.map((p) => `${p.path} [${p.min}–${p.max}]${p.boolean ? ' (0/1)' : ''}`),
        })
      }
      case 'run_scenario': {
        const label = String(input.label ?? '').trim()
        if (!label) throw new Error('label must be a non-empty string')
        const waves = input.waves as { weeksAfterFreeze: number; pct: number }[]
        const stepDowns = input.step_downs as { week: number; pct: number }[]
        const balance = input.balance as { mode: string; order: string[]; email_floor: number }[] | undefined
        const book = input.book as unknown[] | undefined
        const inputs = applyChanges(this.screen(), {
          changes: (input.changes as Change[]) ?? [],
          waves: waves?.length ? waves : undefined,
          stepDowns: stepDowns?.length ? stepDowns : undefined,
          balance: balance?.length ? { mode: balance[0].mode, order: balance[0].order, emailFloor: balance[0].email_floor } : undefined,
          book: book?.length ? book[0] : undefined,
        })
        const result = run(inputs)
        this.runs.set(label, { inputs, result })
        // changes to inputs the scenario's mode does not use (book.* in manual mode, people.* with the split off) have no effect: say so
        const inert = ((input.changes as Change[]) ?? []).map((c) => c.path).filter((p) => p !== 'book.useBook' && p !== 'people.split' && !activePath(inputs, p))
        return JSON.stringify({ label, results: this.headline({ inputs, result }), warnings: [...result.warnings, ...(inert.length ? [`No effect in this mode: ${inert.join(', ')} (turn on book mode / the split first).`] : [])], weekly: tidy(weeklyTable(result), 3) })
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
          return { value, worstWeek: k.worstWeek, worstGrade: k.worstGrade, worstChannel: k.worstChannel, weeksBelowTarget: k.weeksBelowTarget, peakUtilisation: k.peakUtilisation, largestFteGap: k.largestFteGap, peakAbandonment: k.peakAbandonment }
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
          averageBandWidth: b.bandWidth, troughRange: b.trough, drawnAssumptions: b.drawnPaths.length,
          freezeEndWeek: b.freezeEnd, register: statusCounts(s.inputs), worstWeeksOfMostLikelyRun: graded.map(at),
          note: 'Service arrays are [10th, 50th, 90th] percentile across futures.',
        }, 3))
      }
      case 'compare': {
        const labels = (input.labels as string[]).slice(0, 6)
        return JSON.stringify(labels.map((l) => ({ label: l || 'on screen', results: this.headline(this.resolve(l)) })))
      }
      case 'record_assumption': {
        const path = String(input.path)
        const [low, likely, high] = [Number(input.low), Number(input.likely), Number(input.high)]
        if (![low, likely, high].every(Number.isFinite) || low > likely || likely > high) throw new Error('need low ≤ likely ≤ high')
        const status = input.status as 'estimated' | 'confirmed' | 'default'
        const next = structuredClone(this.screen())
        recordAnswer(next, path, { low, likely, high, status, owner: String(input.owner ?? '') || undefined, note: String(input.note ?? '') || undefined })
        this.show(next, `answer: ${path}`)
        return JSON.stringify({ recorded: path, entry: next.assumptions[path], register: statusCounts(next), note: 'On screen; run run_monte_carlo on "" to see how much the bands narrowed.' })
      }
      case 'set_book': {
        const label = String(input.label ?? '').trim()
        const { label: _l, ...book } = input as Record<string, unknown>
        void _l
        const next = applyChanges(this.screen(), { book: { ...book, mode: 'book' } })
        const result = run(next)
        const curve = result.book ?? expectedBook(next, result.freezeEnd)
        if (label) {
          this.runs.set(label, { inputs: next, result })
          return JSON.stringify({ label, results: this.headline({ inputs: next, result }), impliedFates: tidy(curve.impliedFates, 3), transferShareAtAnnouncement: tidy(curve.transferShareAtAnnouncement, 3) })
        }
        this.show(next, 'book of business')
        return JSON.stringify({ applied: 'book of business', impliedFates: tidy(curve.impliedFates, 3), transferShareAtAnnouncement: tidy(curve.transferShareAtAnnouncement, 3), register: statusCounts(next), note: 'Book mode is on screen (manual step-downs, runoff and waves are ignored); the user can undo.' })
      }
      case 'explain_book': {
        const s = this.resolve(String(input.label ?? ''))
        const r = run(s.inputs)
        const curve = expectedBook(s.inputs, r.freezeEnd)
        const W = s.inputs.horizonWeeks
        const pts = Array.from({ length: 12 }, (_, i) => Math.min(W - 1, Math.round((i * (W - 1)) / 11)))
        const staircase = pts.map((w) => ({ week: w, bookRemaining: curve.remaining[w] }))
        const leaving = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
        return JSON.stringify(tidy({
          mode: s.inputs.book.mode,
          note: s.inputs.book.mode === 'book' ? 'This is the curve the scenario runs on (expected; the Monte Carlo draws real staircases).' : 'The scenario is in manual mode; this is what the book block would give if book mode were on.',
          freezeEnd: r.freezeEnd,
          waves: bookWaves(s.inputs.book).map((w) => ({ week: r.freezeEnd + w.offset, shareOfTransferringWork: w.share })),
          impliedFates: curve.impliedFates,
          transferShareAtAnnouncement: curve.transferShareAtAnnouncement,
          leavesWithinHorizon: { transfer: leaving(curve.transferLeaving), exit: leaving(curve.exitLeaving), replatform: leaving(curve.replatformLeaving), staysBeyondHorizon: curve.remaining[W - 1] },
          staircase,
          book: s.inputs.book,
        }, 3))
      }
      case 'apply_to_calculator': {
        const label = String(input.label ?? '')
        const s = this.resolve(label)
        if (!label) throw new Error('Give the label of a scenario from run_scenario')
        this.show(structuredClone(s.inputs), label)
        return JSON.stringify({ applied: label, note: 'The scenario is now on screen; the user can undo.' })
      }
      default:
        throw new Error(`Unknown tool ${name}`)
    }
  }
}
