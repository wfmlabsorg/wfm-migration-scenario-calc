import {
  CategoryScale, Chart as ChartJS, Filler, Legend, LinearScale, LineElement, PointElement, Tooltip,
  type ChartDataset, type ChartOptions,
} from 'chart.js'
import annotationPlugin from 'chartjs-plugin-annotation'
import { Line } from 'react-chartjs-2'
import type { McBands } from '../../lib/montecarlo'
import type { RunResult } from '../../lib/types'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend, annotationPlugin)

const FONT = { family: "'IBM Plex Sans', ui-sans-serif, system-ui", size: 10 }
const GRID = 'rgba(55,65,81,0.3)'
export const COLORS = { voice: '#22d3ee', chat: '#a78bfa', email: '#f59e0b', avail: '#22d3ee', req: '#ef4444', heads: '#94a3b8' }

const pctOrNull = (x: number) => (Number.isFinite(x) ? Math.round(x * 1000) / 10 : null)
const numOrNull = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null)

function annotations(r: RunResult, targets: { value: number; label: string }[] = []) {
  const a: Record<string, object> = {
    freeze: {
      type: 'box', xMin: r.freezeStart - 0.5, xMax: r.freezeEnd - 0.5,
      backgroundColor: 'rgba(148,163,184,0.10)', borderWidth: 0,
      label: { display: true, content: 'Freeze', position: { x: 'center', y: 'start' }, color: '#94a3b8', font: FONT },
    },
  }
  r.waveWeeks.forEach((w, i) => {
    if (w < r.weeks.length)
      a[`wave${i}`] = {
        type: 'line', xMin: w, xMax: w, borderColor: 'rgba(250,204,21,0.6)', borderWidth: 1, borderDash: [3, 3],
        // stagger labels so close waves don't collide on narrow screens
        label: { display: true, content: `Wave ${i + 1}`, position: 'end', yAdjust: (i % 2) * 14, color: '#facc15', backgroundColor: 'transparent', font: FONT },
      }
  })
  targets.forEach((t, i) => {
    a[`target${i}`] = {
      type: 'line', yMin: t.value, yMax: t.value, borderColor: 'rgba(239,68,68,0.55)', borderWidth: 1, borderDash: [6, 4],
      label: { display: true, content: t.label, position: 'start', color: '#f87171', backgroundColor: 'transparent', font: FONT },
    }
  })
  return a
}

function options(yTitle: string, yMax: number | undefined, ann: Record<string, object>): ChartOptions<'line'> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: '#cbd5e1', font: FONT, boxWidth: 12, filter: (item) => !item.text.startsWith('_') } },
      tooltip: {
        backgroundColor: '#1a2332', borderColor: '#2a3444', borderWidth: 1, titleFont: FONT, bodyFont: FONT,
        filter: (item) => !item.dataset.label?.startsWith('_'),
      },
      annotation: { annotations: ann },
    },
    scales: {
      x: { ticks: { color: '#94a3b8', font: FONT, maxRotation: 0, autoSkipPadding: 12 }, grid: { color: GRID } },
      y: { min: 0, max: yMax, title: { display: true, text: yTitle, color: '#94a3b8', font: FONT }, ticks: { color: '#94a3b8', font: FONT }, grid: { color: GRID } },
    },
  }
}

function band(label: string, lo: number[], hi: number[], color: string, f: (x: number) => number | null): ChartDataset<'line'>[] {
  return [
    { label: `_${label} lo`, data: lo.map(f), borderWidth: 0, pointRadius: 0, fill: false },
    { label: `_${label} hi`, data: hi.map(f), borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: `${color}26` },
  ]
}

interface Props {
  result: RunResult
  compare?: RunResult | null
  erlangC?: RunResult | null // the same scenario under Erlang C, for comparison
  bands?: McBands | null
  targets: { voice: number; chat: number }
}

export function ServiceChart({ result, compare, erlangC, bands, targets }: Props) {
  const labels = result.weeks.map((w) => `W${w.week}`)
  const ds: ChartDataset<'line'>[] = []
  if (bands) {
    ds.push(...band('Voice', bands.p10.voice, bands.p90.voice, COLORS.voice, pctOrNull))
    ds.push(...band('Chat', bands.p10.chat, bands.p90.chat, COLORS.chat, pctOrNull))
    ds.push(...band('Email', bands.p10.email, bands.p90.email, COLORS.email, pctOrNull))
  }
  const line = (label: string, data: (number | null)[], color: string, dashed = false, dash?: number[], width?: number): ChartDataset<'line'> => ({
    label, data, borderColor: color, backgroundColor: color, borderWidth: width ?? (dashed ? 1.5 : 2), borderDash: dash ?? (dashed ? [5, 4] : undefined),
    pointRadius: 0, tension: 0.15, spanGaps: false,
  })
  const abandons = result.weeks.some((w) => w.voice.abandoned > 0 || w.chat.abandoned > 0)
  ds.push(line('Voice SL', result.weeks.map((w) => pctOrNull(w.voice.sl)), COLORS.voice))
  const hasChat = result.weeks.some((w) => w.chat.scored)
  if (hasChat) ds.push(line('Chat SL', result.weeks.map((w) => pctOrNull(w.chat.sl)), COLORS.chat))
  ds.push(line('Email on-time', result.weeks.map((w) => pctOrNull(w.email.timeliness)), COLORS.email))
  if (abandons) {
    ds.push(line('Voice abandon', result.weeks.map((w) => pctOrNull(w.voice.abandonRate)), COLORS.voice, false, [1, 3], 1.5))
    if (hasChat) ds.push(line('Chat abandon', result.weeks.map((w) => pctOrNull(w.chat.abandonRate)), COLORS.chat, false, [1, 3], 1.5))
  }
  if (erlangC) {
    ds.push(line('Voice (Erlang C)', erlangC.weeks.map((w) => pctOrNull(w.voice.sl)), `${COLORS.voice}99`, false, [2, 2], 1))
    if (hasChat) ds.push(line('Chat (Erlang C)', erlangC.weeks.map((w) => pctOrNull(w.chat.sl)), `${COLORS.chat}99`, false, [2, 2], 1))
    ds.push(line('Email (Erlang C)', erlangC.weeks.map((w) => pctOrNull(w.email.timeliness)), `${COLORS.email}99`, false, [2, 2], 1))
  }
  if (compare) {
    ds.push(line('Voice (scenario A)', compare.weeks.map((w) => pctOrNull(w.voice.sl)), COLORS.voice, true))
    if (hasChat) ds.push(line('Chat (scenario A)', compare.weeks.map((w) => pctOrNull(w.chat.sl)), COLORS.chat, true))
    ds.push(line('Email (scenario A)', compare.weeks.map((w) => pctOrNull(w.email.timeliness)), COLORS.email, true))
  }
  const tg = targets.voice === targets.chat
    ? [{ value: targets.voice * 100, label: `Target ${Math.round(targets.voice * 100)}%` }]
    : [{ value: targets.voice * 100, label: `Voice target ${Math.round(targets.voice * 100)}%` }, { value: targets.chat * 100, label: `Chat target ${Math.round(targets.chat * 100)}%` }]
  return (
    <div className="h-[300px]">
      <Line data={{ labels, datasets: ds }} options={options(abandons ? 'Service level / on-time / abandon %' : 'Service level / on-time %', 100, annotations(result, tg))} />
    </div>
  )
}

export function CapacityChart({ result, compare, bands }: Omit<Props, 'targets'>) {
  const labels = result.weeks.map((w) => `W${w.week}`)
  const ds: ChartDataset<'line'>[] = []
  if (bands) ds.push(...band('Available', bands.p10.fteAvail, bands.p90.fteAvail, COLORS.avail, numOrNull))
  ds.push({ label: 'Available FTE (productive, incl. borrowed)', data: result.weeks.map((w) => numOrNull(w.fteAvail)), borderColor: COLORS.avail, backgroundColor: COLORS.avail, borderWidth: 2, pointRadius: 0 })
  ds.push({ label: 'Required FTE (all targets met)', data: result.weeks.map((w) => numOrNull(w.fteReq)), borderColor: COLORS.req, backgroundColor: COLORS.req, borderWidth: 2, borderDash: [6, 4], pointRadius: 0 })
  ds.push({ label: 'Headcount', data: result.weeks.map((w) => numOrNull(w.heads)), borderColor: COLORS.heads, backgroundColor: COLORS.heads, borderWidth: 1.5, pointRadius: 0 })
  if (compare) ds.push({ label: 'Available FTE (scenario A)', data: compare.weeks.map((w) => numOrNull(w.fteAvail)), borderColor: COLORS.avail, borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0 })
  return (
    <div className="h-[260px]">
      <Line data={{ labels, datasets: ds }} options={options('FTE', undefined, annotations(result))} />
    </div>
  )
}
