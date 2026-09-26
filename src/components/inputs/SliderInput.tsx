interface Props {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format?: 'percent' | 'number' | 'currency' | 'multiplier'
}

function formatValue(value: number, format?: string): string {
  switch (format) {
    case 'percent':
      return `${Number.isInteger(Math.round(value * 1000) / 10) ? Math.round(value * 100) : (value * 100).toFixed(1)}%`
    case 'currency':
      return `$${Math.round(value).toLocaleString()}`
    case 'multiplier':
      return `${value.toFixed(1)}x`
    default:
      return value % 1 === 0 ? value.toLocaleString() : value.toFixed(2)
  }
}

export default function SliderInput({ label, value, min, max, step, onChange, format }: Props) {
  return (
    <div className="mb-3">
      <div className="flex justify-between items-center mb-1">
        <label className="text-xs font-medium text-gray-300">{label}</label>
        <span className="text-xs font-semibold text-brand-400">{formatValue(value, format)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full"
      />
      <div className="flex justify-between text-[10px] text-gray-500 mt-0.5">
        <span>{formatValue(min, format)}</span>
        <span>{formatValue(max, format)}</span>
      </div>
    </div>
  )
}
