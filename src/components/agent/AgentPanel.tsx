import type Anthropic from '@anthropic-ai/sdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AgentError, ask, type ToolEvent } from '../../agent/loop'
import { AgentTools } from '../../agent/tools'
import { download } from '../../lib/csv'
import { dossier, type ChatEntry, type ChatPart } from '../../lib/dossier'
import type { McBands } from '../../lib/montecarlo'
import type { Inputs, RunResult } from '../../lib/types'
import Markdown from './Markdown'

const STARTERS = [
  'Why does service break when it does?',
  'How many borrowed FTE would keep every week on target?',
  'What if the freeze runs 8 weeks longer?',
  'Explain the worst week step by step.',
  'Describe our book: 40% fixed-term expiring weeks 10–40, 40% rolling, 20% rolling with termination for convenience; 50/35/15 green/amber/red. What are the implied fates and the worst week?',
  'Split the team at the announcement; what does a 40% retention offer to the release group do to the worst week?',
]

function ToolChip({ t }: { t: ToolEvent }) {
  const [open, setOpen] = useState(false)
  let pretty = t.output
  try {
    pretty = JSON.stringify(JSON.parse(t.output), null, 1)
  } catch {
    /* keep text */
  }
  return (
    <div className={`rounded border text-[11px] my-1 ${t.error ? 'border-red-500/40 bg-red-500/5' : 'border-brand-500/30 bg-brand-500/5'}`}>
      <button onClick={() => setOpen(!open)} className="w-full text-left px-2 py-1 flex items-center gap-2 text-gray-300">
        <span className="text-brand-400">{open ? '▾' : '▸'}</span>
        <span className="font-mono">{t.name}</span>
        <span className="text-gray-500 truncate">{JSON.stringify(t.input)}</span>
      </button>
      {open && <pre className="px-2 pb-2 max-h-64 overflow-auto text-[10px] text-gray-400 whitespace-pre-wrap">{pretty}</pre>}
    </div>
  )
}

interface Props {
  open: boolean
  onClose: () => void
  inputs: Inputs
  result: RunResult
  onApply: (next: Inputs, label: string) => void
}

function runMonteCarloInWorker(inputs: Inputs, draws: number): Promise<McBands> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../../workers/mc.worker.ts', import.meta.url), { type: 'module' })
    const i = structuredClone(inputs)
    i.uncertainty.draws = draws
    w.onmessage = (e: MessageEvent<{ done: boolean; bands: McBands }>) => {
      if (e.data.done) {
        resolve(e.data.bands)
        w.terminate()
      }
    }
    w.onerror = (e) => {
      reject(new Error(e.message))
      w.terminate()
    }
    w.postMessage({ inputs: i, gen: 1 })
  })
}

export default function AgentPanel({ open, onClose, inputs, result, onApply }: Props) {
  const [chat, setChat] = useState<ChatEntry[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [budget, setBudget] = useState<number | null>(null)
  const history = useRef<Anthropic.MessageParam[]>([])
  const inputsRef = useRef(inputs)
  inputsRef.current = inputs
  const abortRef = useRef<AbortController | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const tools = useMemo(
    () => new AgentTools({ getInputs: () => inputsRef.current, applyInputs: onApply, monteCarlo: runMonteCarloInWorker }),
    [onApply],
  )

  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [chat, busy])

  const send = async (text: string) => {
    const q = text.trim()
    if (!q || busy) return
    setDraft('')
    setError(null)
    setBusy(true)
    const ac = new AbortController()
    abortRef.current = ac
    // one user entry, then one assistant entry that accumulates text and tool calls across rounds
    setChat((c) => [...c, { role: 'user', text: q, tools: [] }, { role: 'assistant', text: '', tools: [], parts: [] }])
    const patch = (f: (e: ChatEntry) => ChatEntry) => setChat((c) => [...c.slice(0, -1), f(c[c.length - 1])])
    let turnStart: ChatEntry | null = null // snapshot of the answer before the current model turn
    try {
      await ask(history.current, q, tools, {
        signal: ac.signal,
        onText: (d) =>
          patch((e) => {
            const parts: ChatPart[] = [...(e.parts ?? [])]
            const last = parts[parts.length - 1]
            if (last?.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: last.text + d }
            else parts.push({ kind: 'text', text: d })
            return { ...e, text: e.text + d, parts }
          }),
        onTool: (t) => patch((e) => ({ ...e, tools: [...e.tools, t], text: e.text ? `${e.text}\n\n` : e.text, parts: [...(e.parts ?? []), { kind: 'tool', tool: t }] })),
        onAssistant: () => undefined,
        onBudget: setBudget,
        onTurnStart: () => setChat((c) => { turnStart = c[c.length - 1]; return c }),
        onRetry: () => patch((e) => turnStart ?? e),
      })
    } catch (e) {
      if ((e as Error).name === 'AbortError') setError('Stopped.')
      else setError(e instanceof AgentError ? e.message : 'The analyst could not be reached. The calculator still works.')
      // drop any dangling unanswered turn so the next question starts cleanly
      const h = history.current
      while (h.length && (h[h.length - 1].role !== 'assistant' || (h[h.length - 1].content as Anthropic.ContentBlock[]).some((b) => b.type === 'tool_use'))) h.pop()
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  const reset = () => {
    history.current = []
    setChat([])
    setError(null)
  }

  if (!open) return null
  return (
    <div className="fixed inset-y-0 right-0 z-30 w-full sm:w-[440px] bg-card border-l border-card-border shadow-2xl flex flex-col">
      <div className="px-4 py-2.5 border-b border-card-border flex items-center justify-between">
        <div>
          <p className="text-sm font-bold text-white">Ask the analyst</p>
          <p className="text-[10px] text-gray-500">It recalculates with the engine; tap a step to see the maths.</p>
        </div>
        <div className="flex items-center gap-2">
          {chat.length > 0 && (
            <>
              <button title="Export the scenario dossier, including this conversation" onClick={() => download('scenario-dossier.md', dossier(inputs, result, location.href, chat))} className="text-[11px] text-gray-400 hover:text-brand-400">Export</button>
              <button onClick={reset} className="text-[11px] text-gray-400 hover:text-brand-400">New</button>
            </>
          )}
          <button onClick={onClose} className="text-gray-500 hover:text-white" aria-label="Close">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {chat.length === 0 && (
          <div className="space-y-2">
            <p className="text-[12px] text-gray-400">Ask about the scenario on screen. The analyst runs the model to answer and shows its working.</p>
            {STARTERS.map((s) => (
              <button key={s} onClick={() => send(s)} className="block w-full text-left text-[12px] px-3 py-2 rounded border border-card-border hover:border-brand-500/50 text-gray-300">{s}</button>
            ))}
          </div>
        )}
        {chat.map((e, k) =>
          e.role === 'user' ? (
            <div key={k} className="ml-8 rounded-lg bg-brand-500/15 border border-brand-500/30 px-3 py-2 text-[13px] text-gray-100">{e.text}</div>
          ) : (
            <div key={k}>
              {(e.parts ?? []).map((p, i) => (p.kind === 'tool' ? <ToolChip key={p.tool.id} t={p.tool} /> : <Markdown key={i} text={p.text} />))}
              {busy && k === chat.length - 1 && <p className="text-[12px] text-gray-500 animate-pulse">Working…</p>}
            </div>
          ),
        )}
        {error && <p className="text-[12px] text-amber-300">{error}</p>}
        <div ref={endRef} />
      </div>

      <div className="border-t border-card-border p-3">
        <form onSubmit={(ev) => { ev.preventDefault(); send(draft) }} className="flex gap-2">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask why, or what if…" maxLength={2000} disabled={busy} className="flex-1" />
          {busy ? (
            <button type="button" onClick={() => abortRef.current?.abort()} className="text-xs px-3 rounded border border-card-border text-gray-300">Stop</button>
          ) : (
            <button type="submit" className="text-xs px-3 rounded bg-brand-500 text-white disabled:opacity-40" disabled={!draft.trim()}>Ask</button>
          )}
        </form>
        <p className="text-[9px] text-gray-600 mt-1.5">
          AI analyst (Claude). It can make mistakes; check the numbers in the tool steps. Don’t share personal or company-confidential information.
          {budget !== null && budget < 1 ? ' Today’s analyst allowance is nearly used.' : ''}
        </p>
      </div>
    </div>
  )
}
