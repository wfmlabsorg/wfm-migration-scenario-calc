import type { GradeInfo } from '../../lib/types'

interface Props {
  label: string
  gradeInfo: GradeInfo
  score: number
  large?: boolean
}

export default function RiskBadge({ label, gradeInfo, score, large }: Props) {
  return (
    <div className={`rounded-lg border border-card-border bg-card p-4 text-center transition-all duration-200 hover:scale-[1.02] ${large ? 'bg-brand-500/10 border-brand-500/30' : ''}`}>
      <p className="text-[10px] text-gray-400 uppercase tracking-wider mb-2">{label}</p>
      <p
        className={`font-bold ${large ? 'text-4xl' : 'text-2xl'}`}
        style={{ color: gradeInfo.color }}
      >
        {gradeInfo.grade}
      </p>
      <p className="text-xs text-gray-300 mt-1">{gradeInfo.rating}</p>
      <p className="text-[10px] text-gray-500 mt-0.5">{Math.round(score * 100)}%</p>
    </div>
  )
}
