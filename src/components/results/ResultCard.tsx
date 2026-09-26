interface Props {
  label: string
  sublabel?: string
  value: string
  icon?: string
  accent?: boolean
  large?: boolean
  note?: string // one short line under the value
}

export default function ResultCard({ label, sublabel, value, icon, accent, large, note }: Props) {
  return (
    <div
      className={`rounded-lg p-4 border transition-all duration-200 hover:scale-[1.02] ${
        accent
          ? 'bg-brand-500/15 border-brand-500/40'
          : 'bg-card border-card-border'
      }`}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className={`font-semibold text-gray-200 ${large ? 'text-sm' : 'text-xs'}`}>
            {label}
          </p>
          {sublabel && <p className="text-[10px] text-gray-400 mt-0.5">{sublabel}</p>}
          <p className={`font-bold mt-1 ${accent ? 'text-brand-400' : 'text-white'} ${large ? 'text-2xl' : 'text-lg'}`}>
            {value}
          </p>
          {note && <p className={`text-[10px] mt-0.5 ${accent ? 'text-amber-300' : 'text-gray-500'}`}>{note}</p>}
        </div>
        {icon && <div className="text-xl ml-2 opacity-40">{icon}</div>}
      </div>
    </div>
  )
}
