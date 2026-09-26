import { scoreToGrade } from './grade'
import type { RunResult } from './types'

const pct = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(1) : '')
const num = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '')

export function toCsv(r: RunResult): string {
  const head = [
    'week', 'phase', 'heads', 'hired', 'attrition', 'moved_out', 'released', 'training_hours', 'surge_pts',
    'fte_available', 'fte_required', 'utilisation_pct', 'voice_volume', 'voice_sl_pct', 'voice_abandon_pct', 'chat_volume', 'chat_sl_pct', 'chat_abandon_pct',
    'email_volume', 'email_backlog_hours', 'email_backlog_days', 'email_on_time_index_pct', 'borrowed_hours_used',
    'meets_all_targets', 'grade',
  ]
  const rows = r.weeks.map((w) => [
    w.week, w.phase, num(w.heads), num(w.hired), num(w.attrition), num(w.moved), num(w.released), num(w.trainingHours, 0),
    num(w.surgePts * 100), num(w.fteAvail), num(w.fteReq), pct(w.utilisation), num(w.voice.volume, 0), pct(w.voice.sl),
    pct(w.voice.abandonRate), num(w.chat.volume, 0), pct(w.chat.sl), pct(w.chat.abandonRate), num(w.email.volume, 0), num(w.email.backlogHours, 0), num(w.email.backlogDays, 2),
    pct(w.email.timeliness), num(w.borrowedUsedHours, 0), w.meetsAll ? 'yes' : 'no',
    Number.isFinite(w.score) ? scoreToGrade(w.score).grade : '',
  ])
  return [head, ...rows].map((r) => r.join(',')).join('\n')
}

export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}
