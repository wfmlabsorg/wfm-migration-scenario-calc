import { afterEach, describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import { AgentError, ask } from '../src/agent/loop'
import { AgentTools } from '../src/agent/tools'
import { DEFAULTS } from './legacyDemo'
import { simulate } from '../src/lib/montecarlo'

// The relay streams the SDK's newline-delimited event format (MessageStream.toReadableStream).
function textTurn(text: string): Response {
  const events = [
    { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map((e) => JSON.stringify(e)).join('\n') + '\n', { status: 200, headers: { 'x-analyst-budget-remaining': '3.50' } })
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})
const tools = () => new AgentTools({ getInputs: () => structuredClone(DEFAULTS), applyInputs: () => undefined, monteCarlo: async (i, d) => simulate(i, d, 1) })

describe('network retries', () => {
  test('a dropped turn is re-issued once and its partial text discarded', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) throw new TypeError('network changed')
      return textTurn('All good.')
    }) as unknown as typeof fetch
    const history: Anthropic.MessageParam[] = []
    let text = ''
    let retries = 0
    let budget = NaN
    await ask(history, 'q', tools(), {
      onText: (d) => (text += d),
      onTool: () => undefined,
      onAssistant: () => undefined,
      onRetry: () => { retries++; text = '' },
      onBudget: (b) => (budget = b),
    })
    expect(calls).toBe(2)
    expect(retries).toBe(1)
    expect(text).toBe('All good.')
    expect(budget).toBe(3.5)
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  test('caps and quota errors are not retried', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response(JSON.stringify({ error: 'daily_cap', message: 'limit' }), { status: 429 })
    }) as unknown as typeof fetch
    await expect(ask([], 'q', tools(), { onText: () => undefined, onTool: () => undefined, onAssistant: () => undefined })).rejects.toBeInstanceOf(AgentError)
    expect(calls).toBe(1)
  })

  test('gives up after two retries', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      throw new TypeError('offline')
    }) as unknown as typeof fetch
    await expect(ask([], 'q', tools(), { onText: () => undefined, onTool: () => undefined, onAssistant: () => undefined })).rejects.toThrow('offline')
    expect(calls).toBe(3)
  })
})
