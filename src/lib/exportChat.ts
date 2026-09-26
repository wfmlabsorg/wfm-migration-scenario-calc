// Export an analyst conversation together with the scenario it produced, as Markdown.
import type { ToolEvent } from '../agent/loop'
import { kpis } from './kpis'
import { toHash } from './share'
import type { Inputs, RunResult } from './types'
import { codeUrl, COMMIT, ENGINE_VERSION, REPO, SHORT } from './version'

export type ChatPart = { kind: 'text'; text: string } | { kind: 'tool'; tool: ToolEvent }

export interface ChatEntry {
  role: 'user' | 'assistant'
  text: string // all text, concatenated
  tools: ToolEvent[] // all tool calls
  parts?: ChatPart[] // text and tool calls in the order they happened
}

const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—')

function toolSummary(t: ToolEvent): string {
  let result = t.output
  try {
    const j = JSON.parse(t.output) as Record<string, unknown>
    const r = (j.results ?? j) as Record<string, unknown>
    const keep = ['label', 'worstWeek', 'worstGrade', 'worstChannel', 'weeksBelowTarget', 'peakUtilisation', 'largestFteGap', 'shareOfFuturesWithNoBreach', 'gradeOfThatShare', 'applied']
    const brief = Object.fromEntries(Object.entries({ ...j, ...r }).filter(([k]) => keep.includes(k)))
    result = Object.keys(brief).length ? JSON.stringify(brief) : t.output.slice(0, 600) + (t.output.length > 600 ? ' …' : '')
  } catch {
    /* plain text */
  }
  return `> 🔧 **${t.name}**${t.error ? ' (error)' : ''} — input \`${JSON.stringify(t.input)}\`\n>\n> ${result.replace(/\n/g, '\n> ')}`
}

export function chatToMarkdown(chat: ChatEntry[], inputs: Inputs, result: RunResult, pageUrl: string, now = new Date()): string {
  const k = kpis(inputs, result)
  const link = `${pageUrl.split('#')[0]}#${toHash(inputs)}`
  const lines: string[] = [
    '# Migration Scenario Modeler: analyst conversation',
    '',
    `- **Exported:** ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `- **Engine:** v${ENGINE_VERSION}, commit [\`${SHORT}\`](${codeUrl(COMMIT)}) · source: ${REPO}`,
    `- **Scenario (opens in the calculator):** ${link}`,
    '',
    '## Scenario on screen at export',
    '',
    '| Measure | Value |',
    '|---|---|',
    `| Worst week | ${k.worstWeek ?? '—'} (${k.worstGrade}; ${k.worstChannel}) |`,
    `| Weeks below target: voice · chat · email | ${k.weeksBelowTarget.voice} · ${k.weeksBelowTarget.chat} · ${k.weeksBelowTarget.email} |`,
    `| Peak utilisation | ${pct(k.peakUtilisation)} |`,
    `| Largest FTE gap | ${k.largestFteGap.fte.toFixed(1)} (week ${k.largestFteGap.week}) |`,
    `| Freeze | weeks ${k.freezeStart}–${k.freezeEnd} · waves at ${k.waveWeeks.join(', ') || 'none'} |`,
    '',
    '## Conversation',
    '',
  ]
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
  lines.push('## Inputs (JSON)', '', 'Open the scenario link above to reload these exactly.', '', '```json', JSON.stringify(inputs, null, 2), '```', '')
  lines.push('_Demonstration tool: results illustrate the inputs; they are not forecasts or advice._', '')
  return lines.join('\n')
}
