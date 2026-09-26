import type { ServiceModel } from '../../lib/types'
import NumberInput from './NumberInput'

interface Props {
  value: ServiceModel
  onChange: (s: ServiceModel) => void
  showC: boolean
  onShowC: (v: boolean) => void
}

export default function ServiceModelCard({ value, onChange, showC, onShowC }: Props) {
  const isA = value.model === 'A'
  return (
    <div>
      <div className="grid grid-cols-2 gap-1 mb-2">
        {(['A', 'C'] as const).map((m) => (
          <button key={m} onClick={() => onChange({ ...value, model: m })}
            className={`text-[11px] px-2 py-1.5 rounded border ${value.model === m ? 'border-brand-500 bg-brand-500/20 text-white' : 'border-card-border text-gray-400 hover:text-gray-200'}`}>
            {m === 'A' ? 'Erlang A (abandonment)' : 'Erlang C (no abandonment)'}
          </button>
        ))}
      </div>
      {isA ? (
        <>
          <p className="text-[10px] text-gray-400 mb-2">
            Waiting customers give up after about {value.patience.voice} s on the phone and {value.patience.chat} s in chat. Service level counts
            them as misses. Required FTE is still sized with Erlang C.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <NumberInput label="Voice patience (s)" value={value.patience.voice} step={10} min={5}
              onChange={(v) => onChange({ ...value, patience: { ...value.patience, voice: Math.min(3600, Math.max(5, v)) } })} />
            <NumberInput label="Chat patience (s)" value={value.patience.chat} step={10} min={5}
              onChange={(v) => onChange({ ...value, patience: { ...value.patience, chat: Math.min(3600, Math.max(5, v)) } })} />
            <NumberInput label="Redial %" value={Math.round(value.redialRate * 100)} step={5} min={0}
              onChange={(v) => onChange({ ...value, redialRate: Math.min(1, Math.max(0, v / 100)) })} />
            <NumberInput label="Abandon cap %" value={Math.round(value.abandonCap * 100)} step={1} min={1}
              onChange={(v) => onChange({ ...value, abandonCap: Math.min(0.5, Math.max(0.01, v / 100)) })} />
          </div>
          <p className="text-[10px] text-gray-500 mb-2">
            Redial: share of extra abandoners (above today’s rate) who try again next week. Cap: a week whose worst voice or chat
            abandonment is above it grades BBB at best; above twice it, CCC at best. Patience and redial are estimates; use your own.
          </p>
          <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
            <input type="checkbox" checked={showC} onChange={(e) => onShowC(e.target.checked)} />
            Compare with Erlang C (thin dotted lines)
          </label>
        </>
      ) : (
        <p className="text-[10px] text-gray-400">
          Nobody hangs up: an overloaded queue shows service near zero where real customers would abandon. Use it to reproduce
          classic Erlang C planning, or links made before abandonment was modelled.
        </p>
      )}
    </div>
  )
}
