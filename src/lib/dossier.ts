// The scenario dossier: one Markdown document with everything needed to understand, check or
// rebuild a scenario (provenance, instructions for Claude, results, every assumption, the approach,
// the equations, a worked example of the worst week from the engine's own trace, the weekly
// results, any analyst conversation, and the inputs).
import type { ToolEvent } from '../agent/loop'
import { run } from './engine'
import { EQUATIONS } from './equations'
import { scoreToGrade } from './grade'
import { kpis, worstWeek } from './kpis'
import { PATH_META, QUESTIONS, STATUS_LABEL } from './questions'
import { toHash } from './share'
import type { Inputs, RunResult, WeekTrace } from './types'
import { codeUrl, COMMIT, ENGINE_VERSION, REPO, SHORT } from './version'

export type ChatPart = { kind: 'text'; text: string } | { kind: 'tool'; tool: ToolEvent }

export interface ChatEntry {
  role: 'user' | 'assistant'
  text: string // all text, concatenated
  tools: ToolEvent[] // all tool calls
  parts?: ChatPart[] // text and tool calls in the order they happened
}

const pct = (x: number, d = 0) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—')
const n = (x: number, d = 1) => (Number.isFinite(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—')
const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`

function assumptions(i: Inputs): string {
  const c = i.channels
  const groups: [string, [string, string, string][]][] = [
    ['Channels', [
      ['Voice volume', `${n(c.voice.volume, 0)} contacts/week`, 'Baseline weekly contacts'],
      ['Voice AHT', `${c.voice.aht} s`, 'Average handle time'],
      ['Voice target', `${pct(c.voice.slTarget)} in ${c.voice.slSeconds} s`, 'Service-level target and answer threshold'],
      ['Chat volume', `${n(c.chat.volume, 0)} chats/week`, 'Baseline weekly chats'],
      ['Chat AHT / concurrency', `${c.chat.aht} s / ${c.chat.concurrency}`, 'Handle time; chats handled at once (effective AHT = AHT ÷ concurrency)'],
      ['Chat target', `${pct(c.chat.slTarget)} in ${c.chat.slSeconds} s`, 'Service-level target and answer threshold'],
      ['Email volume', `${n(c.email.volume, 0)} emails/week`, 'Baseline weekly emails (deferrable, backlog carries)'],
      ['Email AHT / target', `${c.email.aht} s / ${c.email.targetDays} day(s)`, 'Handle time; turnaround target'],
    ]],
    ['Team', [
      ['Starting headcount', `${i.pool.fte} FTE`, 'Frontline heads at week 0 (one blended team)'],
      ['Shrinkage', pct(i.pool.shrinkage), 'Total, all causes'],
      ['Paid / open hours', `${i.pool.paidHours} h per head / ${i.pool.openHours} h per week`, 'Paid hours per head; hours the queues are open'],
      ['Base attrition', `${pct(i.attrition.annual)} a year`, 'Voluntary leavers at normal times'],
    ]],
    ['Freeze', [
      ['Freeze', `weeks ${i.freeze.startWeek}–${i.freeze.endWeek}`, 'No work moved and nobody replaced; ends with the announcement'],
      ['Tension effect', `× ${i.attrition.tensionMult}`, 'Attrition multiplier during the freeze'],
      ['Backfill before freeze', i.freeze.backfillBefore ? 'yes' : 'no', 'Leavers replaced before the freeze starts'],
    ]],
    ['Demand change', [
      ['Runoff', `${pct(i.demand.runoffPctWeek, 1)} a week from week ${i.demand.runoffStartWeek ?? i.freeze.startWeek}`, 'Existing book lost each week'],
      ['Step-downs', i.demand.stepDowns.map((s) => `week ${s.week}: −${pct(s.pct)}`).join('; ') || 'none', 'Share of the existing book removed that week (e.g. contract ends)'],
      ['Intake', i.demand.intakeOn ? `on, replaces ${pct(i.demand.intakePct)} of runoff` : 'off', 'New demand taken on'],
    ]],
    ['After the freeze', [
      ['Attrition after announcement', `× ${i.attrition.postMult}`, 'Attrition multiplier after the freeze ends'],
      ['Absence surge', `+${pct(i.after.surgePts)} shrinkage for ${i.after.surgeWeeks} weeks`, 'Extra absence after the announcement'],
      ['Waves', i.after.waves.map((w, k) => `${k + 1}: ${pct(w.pct)} of the book at freeze end + ${w.weeksAfterFreeze} wk`).join('; ') || 'none', 'Work and the same share of staff move out'],
      ['Training', `${i.after.trainingHours} h per transferee over ${i.after.trainingWeeks} weeks before each wave`, 'Time off the floor before cutover'],
      ['Releases', i.after.releasesOn ? `on, after ${i.after.noticeWeeks} weeks' notice, ${pct(i.after.releaseBuffer)} buffer` : 'off', 'Surplus staff released'],
    ]],
    ['Borrowed capacity', [
      ['Borrowed', i.borrowed.fte > 0 ? `${i.borrowed.fte} FTE, weeks ${i.borrowed.startWeek}–${i.borrowed.endWeek}` : 'none', 'Staff lent from elsewhere'],
      ['AHT penalty / eligible', `× ${i.borrowed.ahtPenalty} / ${Object.entries(i.borrowed.eligible).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`, 'Slower on unfamiliar work; channels they can take'],
    ]],
    ['Service model', i.service.model === 'A' ? [
      ['Model', 'Erlang A (customers abandon)', 'Delivered service, abandonment and allocation targets; required FTE is still sized with Erlang C'],
      ['Patience (voice / chat)', `${i.service.patience.voice} s / ${i.service.patience.chat} s`, 'Mean time a waiting customer stays before giving up (estimate)'],
      ['Redial rate', pct(i.service.redialRate), 'Share of extra abandoners who try again next week (estimate)'],
      ['Abandonment cap', pct(i.service.abandonCap), 'Worst voice/chat abandonment above this caps the week at BBB; above twice it at CCC'],
    ] : [
      ['Model', 'Erlang C (nobody abandons)', 'Delivered service and sizing both use Erlang C; overloaded queues read near zero'],
    ]],
    ['Channel balancing', [
      ['Policy', i.balance.mode === 'priority' ? `strict priority: ${i.balance.order.join(' → ')}` : i.balance.mode === 'floor' ? `protect email (${pct(i.balance.emailFloor)} of arrivals first), then ${i.balance.order.filter((x) => x !== 'email').join(' → ')}` : i.balance.mode === 'prorata' ? 'share the shortfall (pro rata)' : 'equal attainment', 'Who absorbs a shortfall (see equations, section 4)'],
    ]],
    ['Intraday profile', [
      ['Volume share (peak / shoulder / off-peak)', i.profile.volumeShare.map((x) => pct(x)).join(' / '), 'Share of contacts in each bucket'],
      ['Hour share', i.profile.hourShare.map((x) => pct(x)).join(' / '), 'Share of open hours in each bucket'],
      ['Schedule fit', pct(i.profile.scheduleFit), 'How closely staffing follows the demand shape'],
    ]],
  ]
  if (i.uncertainty.enabled) {
    const u = i.uncertainty
    groups.push(['Uncertainty (Monte Carlo)', [
      ['Futures / seed', `${u.draws} / ${u.seed}`, 'Simulated futures; random seed. Every register entry with a range is drawn (see Assumption register)'],
    ]])
  }
  return groups.map(([g, rows]) => [`### ${g}`, '', '| Input | Value | Meaning |', '|---|---|---|', ...rows.map((r) => row(r)), ''].join('\n')).join('\n')
}

const fmtV = (path: string, x: number) => {
  const u = PATH_META[path]?.unit
  if (u === 'pct') return pct(x, 1)
  const v = Number(x.toPrecision(4)).toLocaleString('en-US')
  return u === 'x' ? `${v}×` : u === 'sec' ? `${v} s` : u === 'weeks' ? `${v} wk` : u === 'hours' ? `${v} h` : v
}
const STRUCTURED_LABEL: Record<string, string> = {
  'after.waves': 'Transfer waves',
  'demand.stepDowns': 'Step-downs',
  'freeze.backfillBefore': 'Backfill before freeze',
  'channels.targets': 'Service targets',
}

function registerSection(i: Inputs): string {
  const qs = [...i.projectQuestions.map((q) => ({ ...q, group: 'Project' })), ...QUESTIONS]
  const lines = ['| Question | Input | Low · likely · high | Status | Owner / note |', '|---|---|---|---|---|']
  const open: string[] = []
  for (const q of qs)
    for (const path of q.sets) {
      const a = i.assumptions[path]
      if (!a) continue
      const range = a.range ? a.range.map((x) => fmtV(path, x)).join(' · ') : '—'
      lines.push(row([`${q.id}: ${q.text}`, PATH_META[path]?.label ?? STRUCTURED_LABEL[path] ?? path, range, STATUS_LABEL[a.status], [a.owner, a.note].filter(Boolean).join(' — ')]))
      if (a.status === 'default' && !open.includes(`${q.id}: ${q.text}`)) open.push(`${q.id}: ${q.text}`)
    }
  return [
    'Each uncertain input carries a range and a status. Not asked = a generic range; estimated = someone gave a range; confirmed = signed off. The on-screen scenario uses the likely values; with uncertainty on, every range is drawn.',
    '',
    ...lines,
    '',
    '**Open questions** (still on generic ranges; answering them narrows the forecast):',
    '',
    ...(open.length ? open.map((q) => `- ${q}`) : ['- none']),
    '',
  ].join('\n')
}

function workedExample(i: Inputs, t: WeekTrace): string {
  const h = t.headcount
  const hr = t.hours
  const e = t.email
  const q = t.required
  const g = t.grade
  const due = e.workedHours + e.backlogOut
  const pol = t.balance
  const lines = [
    `The worst week is **week ${t.week}** (${t.phase === 'pre' ? 'before the freeze' : t.phase === 'freeze' ? 'during the freeze' : 'after the freeze'}). Every number below comes from the engine's trace of that week.`,
    '',
    '**1. Headcount**',
    `- Start ${n(h.start, 2)} heads; waves move out ${n(h.moved, 2)}.`,
    `- Attrition rate q = ${pct(i.attrition.annual)} ÷ 52 × ${h.attritionMultiplier} = ${pct(h.attritionRate, 3)}; lost ${n(h.lost, 2)}. Hired ${n(h.hired, 2)}; released ${n(h.released, 2)}.`,
    `- End = ${n(h.start, 2)} − ${n(h.moved, 2)} − ${n(h.lost, 2)} + ${n(h.hired, 2)} − ${n(h.released, 2)} = **${n(h.end, 2)}**.`,
    '',
    '**2. Productive hours**',
    `- ${n(h.end, 2)} × ${hr.paidHoursPerHead} h × (1 − ${pct(hr.shrinkage)} − ${pct(hr.surgePts)}) = ${n(hr.grossProductive, 1)} h; minus training ${n(hr.trainingHours, 1)} h = **P = ${n(hr.productive, 1)} h**.`,
    `- Borrowed: ${t.borrowed.active ? `${t.borrowed.fte} FTE → ${n(t.borrowed.homeEquivalentHours, 1)} h after the ×${t.borrowed.ahtPenalty} penalty (used ${n(t.borrowed.usedHours, 1)}, idle ${n(t.borrowed.idleHours, 1)})` : 'none this week'}.`,
    '',
    `**3. Allocation: ${pol.mode === 'priority' ? `strict priority ${pol.order.join(' → ')}` : pol.mode === 'floor' ? `protect email (${pct(pol.emailFloor)})` : pol.mode === 'prorata' ? `share the shortfall, r = ${n(pol.ratio ?? 1, 4)}` : `equal attainment, a = ${n(pol.attainment ?? 1, 4)}${pol.fellBackToProrata ? ' (fell back to pro rata)' : ''}`}**`,
    '',
    '| Bucket | Open h | Alloc share | Voice load (Erl) | need | target | given | final | SL | abandon | Chat load (Erl) | need | target | given | final | SL | abandon |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...t.buckets.map((b) => row([b.name, n(b.openHours, 1), pct(b.allocShare, 1), n(b.voice.offeredErlangs, 2), n(b.voice.needAgents, 2), n(b.voice.targetAgents, 2), n(b.voice.agentsBeforeSpare, 2), n(b.voice.agentsFinal, 2), pct(b.voice.serviceLevel, 1), pct(b.voice.abandonRate, 1), n(b.chat.offeredErlangs, 2), n(b.chat.needAgents, 2), n(b.chat.targetAgents, 2), n(b.chat.agentsBeforeSpare, 2), n(b.chat.agentsFinal, 2), pct(b.chat.serviceLevel, 1), pct(b.chat.abandonRate, 1)])),
    '',
    `Service model: ${t.service.model === 'A' ? `Erlang A (patience ${t.service.patience.voice} s voice, ${t.service.patience.chat} s chat); "need" is the Erlang A need at target, sizing uses Erlang C (voice ${t.buckets.map((b) => n(b.voice.sizingNeedAgents, 2)).join(' / ')}, chat ${t.buckets.map((b) => n(b.chat.sizingNeedAgents, 2)).join(' / ')})` : 'Erlang C'}.`,
    ...(t.service.model === 'A' ? [`Retries in this week: voice ${n(t.service.retriesIn.voice, 0)}, chat ${n(t.service.retriesIn.chat, 0)}. Abandoned: voice ${n(t.service.abandoned.voice, 0)}, chat ${n(t.service.abandoned.chat, 0)}; carried to next week: voice ${n(t.service.retriesOut.voice, 0)}, chat ${n(t.service.retriesOut.chat, 0)}.`] : []),
    `Service level = Σ volume share × bucket SL: voice ${pct(t.buckets.reduce((s, b) => s + b.volumeShare * b.voice.serviceLevel, 0), 1)}, chat ${pct(t.buckets.reduce((s, b) => s + b.volumeShare * b.chat.serviceLevel, 0), 1)}.`,
    '',
    '**4. Email**',
    `- Due D = worked + backlog out = ${n(e.workedHours, 1)} + ${n(e.backlogOut, 1)} = ${n(due, 1)} h (arrivals ${n(e.arrivalHours, 1)} h). Need Ê = ${n(e.need, 1)} h; floor ${n(e.floorHours, 1)} h; policy target ${n(e.targetHours, 1)} h.`,
    `- Worked ${n(e.workedBeforeTopUp, 1)} h by the policy + ${n(e.topUpHours, 1)} h top-up = ${n(e.workedHours, 1)} h. Backlog out ${n(e.backlogOut, 1)} h ÷ (${n(e.arrivalHours, 1)} ÷ 5) = ${n(e.backlogDays, 2)} days → on-time = min(1, ${e.targetDays} ÷ ${n(e.backlogDays, 2)}) = **${pct(e.timeliness, 1)}**.`,
    '',
    '**5. Required vs available FTE**',
    `- Peak-bucket need ${n(q.bucketBindHours, 1)} h; total need ${n(q.interactiveNeedHours, 1)} + ${n(q.emailArrivalHours, 1)} + excess backlog ${n(q.excessBacklogHours, 1)} ÷ 4 → ${n(q.requiredHours, 1)} h.`,
    `- Required = ${n(q.requiredHours, 1)} ÷ (${hr.paidHoursPerHead} × (1 − ${pct(hr.shrinkage)})) = **${n(q.fteRequired, 1)} FTE**; available = **${n(q.fteAvailable, 1)} FTE**; cover ${n(g.cover, 3)}.`,
    '',
    '**6. Grade**',
    `- Attainment: voice ${n(g.attainment.voice, 3)}, chat ${n(g.attainment.chat, 3)}, email ${n(g.attainment.email, 3)}; worst ${n(g.worstAttainment, 3)}.`,
    `- ${g.unstable ? 'A queue is unstable (agents ≤ load): score 0.05.' : g.meetsAll ? `All targets met: score = 0.70 + 0.30 × min(1, (${n(g.cover, 3)} − 1) ÷ 0.10) = ${n(g.score, 3)}.` : `Not all met: score = 0.70 × clamp((${n(Math.min(g.worstAttainment, 1), 3)} − 0.5) ÷ 0.5) = ${n(g.score, 3)}.`} ${g.abandonCap < 1 && g.score < g.scoreBeforeCap ? ` Worst abandonment ${pct(g.worstAbandonRate, 1)} exceeds the ${pct(g.abandonCap)} cap${g.worstAbandonRate > 2 * g.abandonCap ? ' twice over' : ''}: score capped at ${n(g.score, 3)}.` : ''} Grade **${Number.isFinite(g.score) ? scoreToGrade(g.score).grade : '—'}**.`,
  ]
  return lines.join('\n')
}

function weeklyTable(r: RunResult): string {
  const head = '| Wk | Phase | Heads | FTE avail | FTE req | Voice SL | Voice ab | Chat SL | Chat ab | Email on-time | Backlog d | Util | Grade |'
  const rows = r.weeks.map((w) => row([
    w.week, w.phase, n(w.heads), n(w.fteAvail), n(w.fteReq), pct(w.voice.sl), pct(w.voice.abandonRate), pct(w.chat.sl), pct(w.chat.abandonRate), pct(w.email.timeliness),
    n(w.email.backlogDays, 2), pct(w.utilisation), Number.isFinite(w.score) ? scoreToGrade(w.score).grade : '— (no work left)',
  ]))
  return [head, '|---|---|---|---|---|---|---|---|---|---|---|---|---|', ...rows].join('\n')
}

function toolSummary(t: ToolEvent): string {
  let result = t.output
  try {
    const j = JSON.parse(t.output) as Record<string, unknown>
    const r = (j.results ?? j) as Record<string, unknown>
    const keep = ['label', 'worstWeek', 'worstGrade', 'worstChannel', 'weeksBelowTarget', 'peakUtilisation', 'largestFteGap', 'peakAbandonment', 'shareOfFuturesWithNoBreach', 'gradeOfThatShare', 'applied']
    const brief = Object.fromEntries(Object.entries({ ...j, ...r }).filter(([k]) => keep.includes(k)))
    result = Object.keys(brief).length ? JSON.stringify(brief) : t.output.slice(0, 600) + (t.output.length > 600 ? ' …' : '')
  } catch {
    /* plain text */
  }
  return `> 🔧 **${t.name}**${t.error ? ' (error)' : ''} — input \`${JSON.stringify(t.input)}\`\n>\n> ${result.replace(/\n/g, '\n> ')}`
}

function conversation(chat: ChatEntry[]): string {
  const lines: string[] = []
  for (const e of chat) {
    if (e.role === 'user') lines.push(`**You:** ${e.text}`, '')
    else {
      const parts: ChatPart[] = e.parts ?? [...e.tools.map((tool) => ({ kind: 'tool' as const, tool })), { kind: 'text' as const, text: e.text }]
      let first = true
      for (const p of parts) {
        if (p.kind === 'tool') lines.push(toolSummary(p.tool), '')
        else if (p.text.trim()) {
          lines.push(`${first ? '**Analyst:** ' : ''}${p.text.trim()}`, '')
          first = false
        }
      }
    }
  }
  return lines.join('\n')
}

const CLAUDE_BRIEF = `This document is a complete, self-contained description of one scenario from the WFM Labs Migration Scenario Modeler: its inputs, the approach, every equation the engine uses, a fully worked example week taken from the engine's own trace, and the week-by-week results.

When you use it:
1. Treat the Assumptions and the Inputs JSON as the only inputs. Don't invent or change any; if something the user asks about isn't specified, say so.
2. Answer questions from the Results, Worked example and Weekly results first; quote weeks and numbers as given.
3. To check a number, recompute it from the Equations and the Worked example. Numbers should agree to rounding.
4. If asked to rebuild the model, implement the Equations section exactly (in the order given in section 3, with the allocation policy in section 4), run it on the Inputs JSON, and confirm it reproduces the Weekly results before exploring changes. Report any week that differs.
5. Keep the model's stated limits in mind: under Erlang C nobody abandons (overloaded queues read near zero), under Erlang A patience is one average and only the redial share of abandoners returns, clients don't leave because service is poor, and it is one blended team with a fixed balancing policy.
6. Results illustrate the inputs; they are not forecasts or advice.`

export function dossier(inputs: Inputs, result: RunResult, pageUrl: string, chat: ChatEntry[] = [], now = new Date()): string {
  const k = kpis(inputs, result)
  const link = `${pageUrl.split('#')[0]}#${toHash(inputs)}`
  const worstW = worstWeek(inputs, result)
  const worst = worstW?.week ?? k.worstWeek ?? 0
  const trace = run(inputs, { traceWeek: worst }).trace!
  const worstChannel = !worstW ? '' : [
    worstW.voice.scored ? { k: `Voice SL ${pct(worstW.voice.sl)}`, a: worstW.voice.sl / inputs.channels.voice.slTarget } : null,
    worstW.chat.scored ? { k: `Chat SL ${pct(worstW.chat.sl)}`, a: worstW.chat.sl / inputs.channels.chat.slTarget } : null,
    worstW.email.scored ? { k: `Email ${pct(worstW.email.timeliness)} on time`, a: worstW.email.timeliness } : null,
  ].filter((x): x is { k: string; a: number } => !!x).sort((x, y) => x.a - y.a)[0]?.k ?? ''
  const worstText = worstW ? `${worst} (${scoreToGrade(worstW.score).grade}; ${worstChannel})` : '—'
  const parts = [
    '# Migration scenario dossier',
    '',
    `- **Exported:** ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `- **Engine:** Migration Scenario Modeler v${ENGINE_VERSION}, commit [\`${SHORT}\`](${codeUrl(COMMIT)}) · source: ${REPO}`,
    `- **Open this scenario in the calculator:** ${link}`,
    '',
    '## 1. Instructions for Claude (or any analyst)',
    '',
    CLAUDE_BRIEF,
    '',
    '## 2. Headline results',
    '',
    '| Measure | Value |',
    '|---|---|',
    row(['Worst week', worstText]),
    row(['Weeks below target: voice · chat · email', `${k.weeksBelowTarget.voice} · ${k.weeksBelowTarget.chat} · ${k.weeksBelowTarget.email}`]),
    row(['Peak utilisation', pct(k.peakUtilisation)]),
    row(['Peak abandonment: voice · chat', inputs.service.model === 'A' ? `${pct(k.peakAbandonment.voice.rate, 1)} (week ${k.peakAbandonment.voice.week}) · ${pct(k.peakAbandonment.chat.rate, 1)} (week ${k.peakAbandonment.chat.week})` : 'n/a (Erlang C: nobody abandons)']),
    row(['Largest FTE gap', `${n(k.largestFteGap.fte)} (week ${k.largestFteGap.week})`]),
    row(['Worst email backlog', `${n(k.worstEmailBacklogDays, 2)} days`]),
    row(['Freeze / waves', `weeks ${k.freezeStart}–${k.freezeEnd} · waves at ${k.waveWeeks.join(', ') || 'none'}`]),
    row(['Headcount flows', `start ${n(k.headcountFlows.start)} + hired ${n(k.headcountFlows.hired)} = attrition ${n(k.headcountFlows.attritionPre + k.headcountFlows.attritionFreeze + k.headcountFlows.attritionPost)} + moved ${n(k.headcountFlows.moved)} + released ${n(k.headcountFlows.released)} + end ${n(k.headcountFlows.end)}`]),
    '',
    '## 3. Assumptions',
    '',
    assumptions(inputs),
    '### Assumption register',
    '',
    registerSection(inputs),
    '## 4. Approach',
    '',
    'A weekly simulation of one blended team. Each week: work arrives (after runoff, step-downs, intake and any migration waves); the team shrinks through waves, attrition and releases (and is backfilled only before the freeze); productive hours are reduced by shrinkage, the absence surge and training; the balancing policy shares those hours between voice and chat (queues in three intraday buckets, sized with Erlang C) and email (a backlog); service (Erlang A with abandonment, or Erlang C), abandonment, required and available FTE and a grade are computed. The equations below are exactly what the engine runs.',
    '',
    '## 5. Equations',
    '',
    EQUATIONS,
    '',
    '## 6. Worked example: the worst week',
    '',
    workedExample(inputs, trace),
    '',
    '## 7. Weekly results',
    '',
    weeklyTable(result),
    '',
  ]
  if (result.warnings.length) parts.push('Warnings: ' + result.warnings.join(' '), '')
  if (chat.length) parts.push('## 8. Analyst conversation', '', conversation(chat))
  parts.push(`## ${chat.length ? 9 : 8}. Inputs (JSON)`, '', 'Paste into the calculator via the link above, or use directly to rebuild the scenario.', '', '```json', JSON.stringify(inputs, null, 2), '```', '')
  parts.push('_Demonstration tool: results illustrate the inputs; they are not forecasts or advice._', '')
  return parts.join('\n')
}
