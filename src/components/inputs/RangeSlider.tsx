interface Props {
  label: string
  minVal: number
  maxVal: number
  rangeMin: number
  rangeMax: number
  step: number
  onMinChange: (v: number) => void
  onMaxChange: (v: number) => void
}

export default function RangeSlider({
  label, minVal, maxVal, rangeMin, rangeMax, step, onMinChange, onMaxChange,
}: Props) {
  return (
    <div className="mb-3">
      <div className="flex justify-between items-center mb-1">
        <label className="text-xs font-medium text-gray-300">{label}</label>
        <span className="text-xs font-semibold">
          <span className="text-red-400">{minVal}%</span>
          <span className="text-gray-500"> / </span>
          <span className="text-green-400">+{maxVal}%</span>
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input
          type="range"
          min={rangeMin}
          max={0}
          step={step}
          value={minVal}
          onChange={(e) => onMinChange(parseFloat(e.target.value))}
          className="w-full"
        />
        <input
          type="range"
          min={0}
          max={rangeMax}
          step={step}
          value={maxVal}
          onChange={(e) => onMaxChange(parseFloat(e.target.value))}
          className="w-full"
        />
      </div>
    </div>
  )
}
