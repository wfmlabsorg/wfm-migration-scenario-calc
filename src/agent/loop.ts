// Browser side of the analyst: sends the conversation to the relay one turn at a time, streams the
// reply, runs any tool calls locally against the engine, and loops until the model is done.
import type Anthropic from '@anthropic-ai/sdk'
import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream'
import { LIMITS } from './relay'
import type { AgentTools } from './tools'

export interface ToolEvent {
  id: string
  name: string
  input: unknown
  output: string
  error: boolean
}

export interface TurnCallbacks {
  onText: (delta: string) => void
  onTool: (ev: ToolEvent) => void
  onAssistant: (content: Anthropic.ContentBlock[]) => void
  onBudget?: (remainingUsd: number) => void
  signal?: AbortSignal
}

export class AgentError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

async function postTurn(messages: Anthropic.MessageParam[], signal?: AbortSignal): Promise<Response> {
  const res = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages }),
    signal,
  })
  if (!res.ok || !res.body) {
    let msg = `The analyst is unavailable (${res.status}).`
    let code = 'http'
    try {
      const j = (await res.json()) as { message?: string; error?: string }
      msg = j.message ?? msg
      code = j.error ?? code
    } catch {
      /* not JSON */
    }
    throw new AgentError(msg, code)
  }
  return res
}

/**
 * Runs one user question to completion. `history` is mutated append-only: assistant content is
 * echoed back exactly as received (thinking blocks included).
 */
export async function ask(history: Anthropic.MessageParam[], question: string, tools: AgentTools, cb: TurnCallbacks): Promise<void> {
  history.push({ role: 'user', content: question })
  for (let round = 0; round <= LIMITS.maxToolRounds; round++) {
    const res = await postTurn(history, cb.signal)
    const budget = Number(res.headers.get('x-analyst-budget-remaining'))
    if (Number.isFinite(budget)) cb.onBudget?.(budget)

    const stream = MessageStream.fromReadableStream(res.body!)
    stream.on('text', (d) => cb.onText(d))
    const msg = await stream.finalMessage()
    history.push({ role: 'assistant', content: msg.content })
    cb.onAssistant(msg.content)

    if (msg.stop_reason === 'refusal') throw new AgentError('The analyst declined to answer that.', 'refusal')
    const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    // end_turn, or max_tokens (a truncated tool call is never run)
    if (msg.stop_reason !== 'tool_use' || uses.length === 0) return

    const results: Anthropic.ToolResultBlockParam[] = []
    for (const u of uses) {
      let output: string
      let error = false
      try {
        output = await tools.execute(u.name, (u.input ?? {}) as Record<string, unknown>)
      } catch (e) {
        output = `Error: ${(e as Error).message}`
        error = true
      }
      cb.onTool({ id: u.id, name: u.name, input: u.input, output, error })
      results.push({ type: 'tool_result', tool_use_id: u.id, content: output, ...(error ? { is_error: true } : {}) })
    }
    history.push({ role: 'user', content: results })
  }
  throw new AgentError('That question needed too many steps. Try asking something narrower.', 'rounds')
}
