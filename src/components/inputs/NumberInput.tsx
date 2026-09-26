interface Props {
  label: string
  value: number
  onChange: (v: number) => void
  prefix?: string
  step?: number
  min?: number
  max?: number
}

export default function NumberInput({ label, value, onChange, prefix, step, min, max }: Props) {
  return (
    <div className="mb-3">
      <label className="block text-xs font-medium text-gray-300 mb-1">{label}</label>
      <div className="relative">
        {prefix && (
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500 text-sm">
            {prefix}
          </span>
        )}
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          step={step}
          min={min}
          max={max}
          className={prefix ? 'pl-6' : ''}
        />
      </div>
    </div>
  )
}
