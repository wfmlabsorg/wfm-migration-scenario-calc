// Pure rules for the server relay: request validation, spend accounting and quotas.
// The Netlify function (netlify/functions/agent.mts) wires these to the API and to Blobs.

export const MODEL = 'claude-sonnet-5'
export const LIMITS = {
  maxBytes: 200_000, // request body
  maxMessages: 60,
  maxToolRounds: 12, // consecutive tool_result turns since the user last typed
  maxUserTextChars: 4000,
  maxToolResultChars: 60_000,
  dailyUsd: 4.0,
  ipRequestsPerHour: 60,
  maxOutputTokens: 8000,
}
// Claude Sonnet 5, $ per million tokens; cache writes 1.25x input, cache reads 0.1x input
const PRICE = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }

export interface UsageLike {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

export function costUsd(u: UsageLike): number {
  return (
    ((u.input_tokens ?? 0) * PRICE.input +
      (u.output_tokens ?? 0) * PRICE.output +
      (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite +
      (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead) /
    1_000_000
  )
}

type Block = { type?: unknown; [k: string]: unknown }
type Msg = { role?: unknown; content?: unknown }

const USER_BLOCKS = new Set(['text', 'tool_result'])
const ASSISTANT_BLOCKS = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use'])
const FORBIDDEN_TOP = ['system', 'tools', 'model', 'max_tokens', 'tool_choice', 'thinking', 'output_config', 'metadata']

export type Validation = { ok: true; messages: Msg[] } | { ok: false; error: string }

/** The client may send only `messages`; everything that costs money or steers the model is fixed server-side. */
export function validateRequest(body: unknown): Validation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Body must be a JSON object' }
  const b = body as Record<string, unknown>
  for (const k of FORBIDDEN_TOP) if (k in b) return { ok: false, error: `"${k}" is set by the server and may not be sent` }
  const extra = Object.keys(b).filter((k) => k !== 'messages')
  if (extra.length) return { ok: false, error: `Unexpected fields: ${extra.join(', ')}` }
  const messages = b.messages
  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, error: 'messages must be a non-empty array' }
  if (messages.length > LIMITS.maxMessages) return { ok: false, error: `Conversation too long (max ${LIMITS.maxMessages} messages); start a new one` }

  let expect: 'user' | 'assistant' = 'user'
  for (const [i, m] of (messages as Msg[]).entries()) {
    if (m.role !== expect) return { ok: false, error: `messages[${i}] should have role ${expect}` }
    expect = expect === 'user' ? 'assistant' : 'user'
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        if (m.content.length > LIMITS.maxUserTextChars) return { ok: false, error: 'Message too long' }
        continue
      }
      if (!Array.isArray(m.content) || m.content.length === 0) return { ok: false, error: `messages[${i}] content is invalid` }
      for (const blk of m.content as Block[]) {
        if (!USER_BLOCKS.has(String(blk.type))) return { ok: false, error: `messages[${i}] may not contain ${String(blk.type)} blocks` }
        if (blk.type === 'text' && String(blk.text ?? '').length > LIMITS.maxUserTextChars) return { ok: false, error: 'Message too long' }
        if (blk.type === 'tool_result' && JSON.stringify(blk.content ?? '').length > LIMITS.maxToolResultChars) return { ok: false, error: 'Tool result too large' }
      }
    } else {
      if (!Array.isArray(m.content)) return { ok: false, error: `messages[${i}] content is invalid` }
      for (const blk of m.content as Block[]) if (!ASSISTANT_BLOCKS.has(String(blk.type))) return { ok: false, error: `messages[${i}] may not contain ${String(blk.type)} blocks` }
    }
  }
  if (expect !== 'assistant') return { ok: false, error: 'The last message must come from the user' }

  // consecutive tool rounds since the user last typed
  let rounds = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Msg
    if (m.role !== 'user') continue
    const isToolOnly = Array.isArray(m.content) && (m.content as Block[]).every((blk) => blk.type === 'tool_result')
    if (!isToolOnly) break
    rounds++
  }
  if (rounds > LIMITS.maxToolRounds) return { ok: false, error: `Too many tool rounds for one question (max ${LIMITS.maxToolRounds})` }
  return { ok: true, messages: messages as Msg[] }
}

/** Mark the last block of the last message for caching, so the growing history is reused turn to turn. */
export function withCacheBreakpoint<T extends Msg>(messages: T[]): T[] {
  const out = structuredClone(messages)
  const last = out[out.length - 1]
  if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }]
  const blocks = last.content as Block[]
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } }
  return out
}

/** Minimal counter store (Netlify Blobs in production, a Map in tests). */
export interface CounterStore {
  read(key: string): Promise<{ value: number; etag?: string } | null>
  /** prev = what read() returned. Conditional on its etag when there is one; false = lost a race. */
  write(key: string, value: number, prev: { value: number; etag?: string } | null): Promise<boolean>
}

export async function addTo(store: CounterStore, key: string, delta: number, tries = 5): Promise<number> {
  for (let i = 0; i < tries; i++) {
    const cur = await store.read(key)
    const next = (cur?.value ?? 0) + delta
    if (await store.write(key, next, cur)) return next
  }
  throw new Error('counter contention')
}

export const dayKey = (d = new Date()) => `spend:${d.toISOString().slice(0, 10)}`
export const hourKey = (ipHash: string, d = new Date()) => `ip:${ipHash}:${d.toISOString().slice(0, 13)}`

export type Gate = { ok: true; spentToday: number } | { ok: false; status: 429; code: 'daily_cap' | 'ip_quota'; message: string }

/** Checks the global daily cap and the per-IP hourly quota, counting this request. */
export async function gate(store: CounterStore, ipHash: string, now = new Date()): Promise<Gate> {
  const spent = (await store.read(dayKey(now)))?.value ?? 0
  if (spent >= LIMITS.dailyUsd)
    return { ok: false, status: 429, code: 'daily_cap', message: 'The analyst has reached today’s usage limit. The calculator still works; the analyst returns tomorrow (UTC).' }
  const n = await addTo(store, hourKey(ipHash, now), 1)
  if (n > LIMITS.ipRequestsPerHour)
    return { ok: false, status: 429, code: 'ip_quota', message: 'You’ve reached the hourly limit for the analyst. Please try again later.' }
  return { ok: true, spentToday: spent }
}
