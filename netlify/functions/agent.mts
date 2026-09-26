// Server relay for the in-app analyst: one model turn per request.
// The browser runs the tools; this function holds the key, fixes the model, system prompt
// and tools, validates the conversation, enforces quotas and the daily spend cap, and streams.
import Anthropic from '@anthropic-ai/sdk'
import { getStore } from '@netlify/blobs'
import type { Config, Context } from '@netlify/functions'
import { SYSTEM_PROMPT } from '../../src/agent/systemPrompt'
import { TOOL_DEFS } from '../../src/agent/toolDefs'
import { addTo, costUsd, dayKey, gate, LIMITS, MODEL, validateRequest, withCacheBreakpoint, type CounterStore } from '../../src/agent/relay'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

function blobCounter(): CounterStore {
  const store = getStore({ name: 'analyst-usage', consistency: 'strong' })
  return {
    async read(key) {
      const r = await store.getWithMetadata(key, { type: 'json' })
      return r ? { value: Number((r.data as { v?: number })?.v ?? 0), etag: r.etag } : null
    },
    async write(key, value, prev) {
      // Conditional writes when the store gives us an ETag; otherwise best effort (the counter
      // may very rarely miss an increment under a race, which is acceptable for a spend cap).
      const res = !prev
        ? await store.setJSON(key, { v: value }, { onlyIfNew: true })
        : prev.etag
          ? await store.setJSON(key, { v: value }, { onlyIfMatch: prev.etag })
          : await store.setJSON(key, { v: value })
      return res.modified
    },
  }
}

async function hashIp(ip: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`wfm-migration:${ip}`))
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' })
  if (!process.env.ANTHROPIC_API_KEY) return json(503, { error: 'unavailable', message: 'The analyst is not configured.' })

  const raw = await req.text()
  if (raw.length > LIMITS.maxBytes) return json(413, { error: 'too_large', message: 'Conversation too large; start a new one.' })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json(400, { error: 'bad_json' })
  }
  const v = validateRequest(body)
  if (!v.ok) return json(400, { error: 'invalid', message: v.error })

  const counter = blobCounter()
  let g: Awaited<ReturnType<typeof gate>>
  try {
    g = await gate(counter, await hashIp(context.ip ?? 'unknown'))
  } catch {
    // fail closed: never spend when the usage counter can't be checked
    return json(503, { error: 'unavailable', message: 'The analyst is temporarily unavailable. The calculator still works.' })
  }
  if (!g.ok) return json(g.status, { error: g.code, message: g.message })

  const client = new Anthropic() // ANTHROPIC_API_KEY from the function environment
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: LIMITS.maxOutputTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools: TOOL_DEFS as unknown as Anthropic.Tool[],
    messages: withCacheBreakpoint(v.messages) as Anthropic.MessageParam[],
  })

  // Wait for the upstream response so a rejected request (400/429/529) becomes a JSON error for
  // the client instead of an empty 200 body from an erroring stream.
  try {
    await stream.withResponse()
  } catch (e) {
    const status = typeof (e as { status?: number }).status === 'number' ? (e as { status: number }).status : 502
    console.error('analyst upstream error', status, String((e as Error).message).slice(0, 300))
    return json(502, { error: 'upstream', message: status === 429 || status === 529 ? 'The analyst is busy; try again in a minute.' : 'The analyst could not start this turn. The calculator still works.' })
  }

  // Record spend when the turn finishes, even after the response has been handed back.
  context.waitUntil(
    stream
      .finalMessage()
      .then((m) => addTo(counter, dayKey(), costUsd(m.usage)))
      .catch(() => undefined),
  )

  return new Response(stream.toReadableStream(), {
    headers: {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-store',
      'x-analyst-budget-remaining': Math.max(0, LIMITS.dailyUsd - g.spentToday).toFixed(2),
    },
  })
}

export const config: Config = {
  path: '/api/agent',
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] },
}
