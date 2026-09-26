import type { Balance, BalanceMode, Channel } from '../../lib/types'

const MODES: { mode: BalanceMode; label: string; help: string }[] = [
  { mode: 'priority', label: 'Strict priority', help: 'Channels take what they need in order; the last one absorbs the whole shortfall.' },
  { mode: 'floor', label: 'Protect email', help: 'Email is guaranteed a share of its arrivals first; voice and chat then follow the order.' },
  { mode: 'prorata', label: 'Share the shortfall', help: 'When short, every channel gets the same fraction of what it needs.' },
  { mode: 'equal', label: 'Equal attainment', help: 'Every channel lands the same distance from its target (service ÷ target; email: on-time).' },
]
const NAMES: Record<Channel, string> = { voice: 'Voice', chat: 'Chat', email: 'Email' }

interface Props {
  value: Balance
  onChange: (b: Balance) => void
}

export default function BalanceCard({ value, onChange }: Props) {
  const move = (i: number, dir: -1 | 1) => {
    const o = [...value.order]
    const j = i + dir
    if (j < 0 || j >= o.length) return
    ;[o[i], o[j]] = [o[j], o[i]]
    onChange({ ...value, order: o })
  }
  const active = MODES.find((m) => m.mode === value.mode) ?? MODES[0]
  const order = value.mode === 'floor' ? value.order.filter((c) => c !== 'email') : value.order
  return (
    <div>
      <div className="grid grid-cols-2 gap-1 mb-2">
        {MODES.map((m) => (
          <button key={m.mode} onClick={() => onChange({ ...value, mode: m.mode })}
            className={`text-[11px] px-2 py-1.5 rounded border ${value.mode === m.mode ? 'border-brand-500 bg-brand-500/20 text-white' : 'border-card-border text-gray-400 hover:text-gray-200'}`}>
            {m.label}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-gray-400 mb-2">{active.help}</p>
      {(value.mode === 'priority' || value.mode === 'floor') && (
        <div className="mb-2">
          <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1">{value.mode === 'floor' ? 'Then voice and chat in order' : 'Order (first is protected)'}</p>
          {order.map((c, i) => (
            <div key={c} className="flex items-center justify-between text-xs text-gray-300 py-0.5">
              <span>{i + 1}. {NAMES[c]}</span>
              <span className="flex gap-1">
                <button aria-label={`Move ${c} up`} className="px-1.5 text-gray-500 hover:text-brand-400 disabled:opacity-30" disabled={i === 0}
                  onClick={() => move(value.order.indexOf(c), -1)}>↑</button>
                <button aria-label={`Move ${c} down`} className="px-1.5 text-gray-500 hover:text-brand-400 disabled:opacity-30" disabled={i === order.length - 1}
                  onClick={() => move(value.order.indexOf(c), 1)}>↓</button>
              </span>
            </div>
          ))}
        </div>
      )}
      {value.mode === 'floor' && (
        <div className="mb-2">
          <div className="flex justify-between items-center mb-1">
            <label className="text-xs font-medium text-gray-300">Email guaranteed</label>
            <span className="text-xs font-semibold text-brand-400">{Math.round(value.emailFloor * 100)}% of arrivals</span>
          </div>
          <input type="range" min={0} max={1} step={0.05} value={value.emailFloor} onChange={(e) => onChange({ ...value, emailFloor: parseFloat(e.target.value) })} className="w-full" />
        </div>
      )}
      <p className="text-[10px] text-gray-500">
        Phone and chat queues near capacity don’t degrade gently: under Erlang C (nobody hangs up) a few percent fewer agents can take service from target to near zero, so spreading a shortfall tends to hurt every channel. Under Erlang A customers give up instead, which softens the collapse but shows as abandonment.
        {value.mode === 'equal' ? ' Equal attainment maximises the worst channel, which is what the grade measures, so it tends to grade best.' : ''}
      </p>
    </div>
  )
}
