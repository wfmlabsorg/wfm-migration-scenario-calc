import type { Triple } from '../../lib/types'

interface Props {
  label: string
  value: Triple
  onChange: (v: Triple) => void
  step?: number
  min?: number
  max?: number
  unit?: string
  hint?: string
}

/** A low · likely · high range. Keeps low ≤ likely ≤ high by moving the neighbours. */
export default function TripleInput({ label, value, onChange, step = 1, min, max, unit, hint }: Props) {
  const clamp = (x: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, x))
  const setAt = (idx: 0 | 1 | 2, raw: number) => {
    if (!Number.isFinite(raw)) return
    const v = clamp(raw)
    const t: Triple = [...value] as Triple
    t[idx] = v
    if (idx === 0) { t[1] = Math.max(t[1], v); t[2] = Math.max(t[2], t[1]) }
    if (idx === 1) { t[0] = Math.min(t[0], v); t[2] = Math.max(t[2], v) }
    if (idx === 2) { t[1] = Math.min(t[1], v); t[0] = Math.min(t[0], t[1]) }
    onChange(t)
  }
  return (
    <div className="mb-3">
      <p className="text-xs font-medium text-gray-300 mb-1">
        {label} <span className="text-[10px] text-gray-500">low · likely · high{unit ? ` (${unit})` : ''}</span>
      </p>
      <div className="grid grid-cols-3 gap-1">
        {([0, 1, 2] as const).map((idx) => (
          <input key={idx} type="number" aria-label={`${label} ${['low', 'likely', 'high'][idx]}`} value={value[idx]} step={step} min={min} max={max}
            onChange={(e) => setAt(idx, parseFloat(e.target.value))} className="!px-2 !py-1 !text-[12px]" />
        ))}
      </div>
      {hint && <p className="text-[10px] text-gray-500 mt-0.5">{hint}</p>}
    </div>
  )
}
