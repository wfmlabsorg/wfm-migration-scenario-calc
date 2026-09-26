// "Book of business": describe the clients by shares (contract mix, relationship health, fate
// priors, notice ranges, waves as shares of transferring work, wave slip) and let the engine
// derive the expected departure curve, instead of hand-entering step-downs and waves.
import { useEffect, useState } from 'react'
import { Line } from 'react-chartjs-2'
import { expectedBook } from '../../lib/book'
import type { Book, Fate, Inputs, Triple, Wave } from '../../lib/types'
import NumberInput from './NumberInput'
import TripleInput from './TripleInput'

interface Props {
  inputs: Inputs
  set: (mutate: (i: Inputs) => void) => void
}

const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`

/** Moves one share to v and rebalances the others proportionally so the three still sum to 1. */
export function rebalance<K extends string>(mix: Record<K, number>, key: K, v: number): Record<K, number> {
  const val = Math.min(1, Math.max(0, v))
  const keys = Object.keys(mix) as K[]
  const others = keys.filter((k) => k !== key)
  const rest = others.reduce((s, k) => s + mix[k], 0)
  const out = { ...mix, [key]: val } as Record<K, number>
  for (const k of others) out[k] = rest > 1e-9 ? ((1 - val) * mix[k]) / rest : (1 - val) / others.length
  return out
}

/** The manual staircase (existing book × waves), same rules as METHOD §1, ignoring intake. */
export function manualStaircase(i: Inputs): number[] {
  const W = i.horizonWeeks
  const start = i.demand.runoffStartWeek ?? i.freeze.startWeek
  const steps = new Map<number, number>()
  for (const s of i.demand.stepDowns) steps.set(s.week, 1 - (1 - (steps.get(s.week) ?? 0)) * (1 - s.pct))
  // waves as conditional shares
  let used = 0
  const waves = [...i.after.waves].sort((a, b) => a.weeksAfterFreeze - b.weeksAfterFreeze).map((w) => {
    const cond = Math.min(1, used < 1 ? w.pct / (1 - used) : 1)
    used = Math.min(1, used + w.pct)
    return { week: i.freeze.endWeek + w.weeksAfterFreeze, cond }
  })
  const out: number[] = []
  let x = 1
  for (let w = 0; w < W; w++) {
    if (w >= start && w > 0) x *= 1 - i.demand.runoffPctWeek
    if (steps.has(w)) x *= 1 - steps.get(w)!
    let m = 1
    for (const wv of waves) if (wv.week <= w) m *= 1 - wv.cond
    out.push(x * m)
  }
  return out
}

function ShareSliders<K extends string>({ title, mix, labels, onChange }: { title: string; mix: Record<K, number>; labels: Record<K, string>; onChange: (m: Record<K, number>) => void }) {
  const keys = Object.keys(mix) as K[]
  const [moved, setMoved] = useState(false)
  useEffect(() => {
    if (!moved) return
    const t = setTimeout(() => setMoved(false), 2000)
    return () => clearTimeout(t)
  }, [moved, mix])
  return (
    <div className="mb-2">
      <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1">{title} <span className="normal-case font-normal text-gray-500">· the other shares rebalance to keep 100%</span></p>
      {moved && <p className="text-[10px] text-amber-300 mb-1" role="status">Other shares rebalanced to keep 100%.</p>}
      {keys.map((k) => (
        <div key={k} className="mb-1.5">
          <div className="flex justify-between items-center">
            <label className="text-[11px] text-gray-300">{labels[k]}</label>
            <span className="text-[11px] font-semibold text-brand-400">{pct(mix[k])}</span>
          </div>
          <input type="range" min={0} max={1} step={0.01} value={mix[k]} aria-label={`${title}: ${labels[k]}`}
            onChange={(e) => { setMoved(true); onChange(rebalance(mix, k, parseFloat(e.target.value))) }} className="w-full" />
        </div>
      ))}
    </div>
  )
}

function PriorsGrid({ priors, onChange }: { priors: Book['priors']; onChange: (p: Book['priors']) => void }) {
  const rows = ['green', 'amber', 'red'] as const
  const cols = ['transfer', 'exit', 'replatform'] as const
  return (
    <table className="w-full text-[10px] text-gray-300 mb-2">
      <thead>
        <tr className="text-gray-500"><th className="text-left font-medium">Health</th>{cols.map((c) => <th key={c} className="font-medium">{c === 'replatform' ? 're-platform' : c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((h) => (
          <tr key={h}>
            <td className="py-0.5 capitalize">{h}</td>
            {cols.map((c) => (
              <td key={c} className="py-0.5 px-0.5">
                <input type="number" min={0} max={100} step={5} aria-label={`${h} ${c} %`} value={Math.round(priors[h][c] * 100)}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onChange({ ...priors, [h]: rebalance(priors[h] as unknown as Record<string, number>, c, v / 100) as unknown as Fate }) }}
                  className="!px-1 !py-0.5 !text-[11px] w-full" />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default function BookCard({ inputs, set }: Props) {
  const b = inputs.book
  const isBook = b.mode === 'book'
  const manual = manualStaircase(inputs)
  let expected: ReturnType<typeof expectedBook> | null = null
  try {
    expected = expectedBook(inputs, inputs.freeze.endWeek)
  } catch {
    expected = null
  }
  const labels = manual.map((_, w) => `W${w}`)
  const line = (label: string, data: number[], color: string, dashed = false) => ({
    label, data: data.map((x) => Math.round(x * 1000) / 10), borderColor: color, backgroundColor: color, borderWidth: dashed ? 1 : 1.5,
    borderDash: dashed ? [3, 3] : undefined, pointRadius: 0, tension: 0.05,
  })
  const f = expected?.impliedFates
  const setBook = (mut: (bk: Book) => void) => set((i) => { mut(i.book) })
  return (
    <div>
      <div className="grid grid-cols-2 gap-1 mb-2">
        {(['manual', 'book'] as const).map((m) => (
          <button key={m} onClick={() => setBook((bk) => { bk.mode = m })}
            className={`text-[11px] px-2 py-1.5 rounded border ${b.mode === m ? 'border-brand-500 bg-brand-500/20 text-white' : 'border-card-border text-gray-400 hover:text-gray-200'}`}>
            {m === 'manual' ? 'Manual (step-downs and waves)' : 'Describe the book'}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-gray-400 mb-2">
        {isBook
          ? 'Describe the clients by shares; the expected departure curve, and the staff who move with the transferring work, are derived. Runoff, step-downs and the waves in "After the freeze" are ignored.'
          : 'Runoff, step-downs and waves are entered by hand in "Demand" and "After the freeze". Switch to describe the book by contract and relationship shares instead.'}
      </p>
      {isBook && (
        <>
          <ShareSliders title="Contract mix (share of workload)" mix={b.contractMix} labels={{ fixed: 'Fixed-term', evergreen: 'Rolling (evergreen)', tfc: 'Rolling with termination for convenience' }}
            onChange={(m) => setBook((bk) => { bk.contractMix = m })} />
          <div className="grid grid-cols-2 gap-2">
            <NumberInput label="Fixed-term expiries from week" value={b.fixedExpiry[0]} step={1} min={0} onChange={(v) => setBook((bk) => { bk.fixedExpiry = [Math.max(0, Math.round(v)), Math.max(Math.max(0, Math.round(v)), bk.fixedExpiry[1])] })} />
            <NumberInput label="…to week" value={b.fixedExpiry[1]} step={1} min={0} onChange={(v) => setBook((bk) => { bk.fixedExpiry = [Math.min(bk.fixedExpiry[0], Math.max(0, Math.round(v))), Math.max(0, Math.round(v))] })} />
          </div>
          <ShareSliders title="Relationship health (share of workload)" mix={b.healthMix} labels={{ green: 'Green', amber: 'Amber', red: 'Red' }}
            onChange={(m) => setBook((bk) => { bk.healthMix = m })} />
          <details className="mb-2">
            <summary className="cursor-pointer text-[11px] text-brand-400 hover:text-brand-300 min-h-8 flex items-center gap-1 list-none">
              <span className="details-chevron text-gray-500">▸</span> Fate by health: transfer · leave · re-platform <span className="text-gray-500">(advanced — click to edit the priors)</span>
            </summary>
            <PriorsGrid priors={b.priors} onChange={(p) => setBook((bk) => { bk.priors = p })} />
          </details>
          <TripleInput label="Exit notice after the announcement, rolling" value={b.exitNotice.evergreen} unit="weeks" min={0} onChange={(v) => setBook((bk) => { bk.exitNotice.evergreen = v })} />
          <TripleInput label="Exit notice, with termination for convenience" value={b.exitNotice.tfc} unit="weeks" min={0} onChange={(v) => setBook((bk) => { bk.exitNotice.tfc = v })} />
          <TripleInput label="Re-platformed work leaves after" value={b.replatformOffset} unit="weeks after freeze end" min={0} onChange={(v) => setBook((bk) => { bk.replatformOffset = v })} />
          <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1">Transfer waves (share of transferring work)</p>
          {b.waves.map((wv: Wave, k: number) => (
            <div key={k} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
              <NumberInput label="Weeks after freeze" value={wv.weeksAfterFreeze} step={1} min={0} onChange={(v) => setBook((bk) => { bk.waves[k].weeksAfterFreeze = Math.max(0, Math.round(v)) })} />
              <NumberInput label="% of transfers" value={Math.round(wv.pct * 100)} step={5} min={0} max={100} onChange={(v) => setBook((bk) => { bk.waves[k].pct = Math.min(1, Math.max(0, v / 100)) })} />
              <button aria-label="Remove wave" className="mb-3 w-8 h-8 rounded text-gray-500 hover:text-red-400 text-sm" onClick={() => setBook((bk) => { bk.waves.splice(k, 1) })}>✕</button>
            </div>
          ))}
          {b.waves.length < 4 && <button className="text-[11px] text-brand-400 hover:text-brand-300 mb-2 min-h-8 px-1" onClick={() => setBook((bk) => { bk.waves.push({ weeksAfterFreeze: 20, pct: 0.2 }) })}>+ Add wave</button>}
          <p className="text-[10px] text-gray-500 mb-2">Waves total {pct(b.waves.reduce((a, w) => a + w.pct, 0))} of the transferring work; any remainder transfers at the last wave.</p>
          <TripleInput label="Wave slip" value={b.waveSlip} unit="weeks added to every wave" min={0} step={1} onChange={(v) => setBook((bk) => { bk.waveSlip = v as Triple })} />
        </>
      )}
      {f && isBook && (
        <p className="text-[11px] text-gray-200 mb-1" data-testid="implied-fates">
          Implied: <b>{pct(f.transfer)}</b> transfers · <b>{pct(f.exit)}</b> leaves · <b>{pct(f.replatform)}</b> re-platforms · transfer share at announcement <b>{pct(expected!.transferShareAtAnnouncement)}</b>
        </p>
      )}
      {isBook && <p className="text-[10px] text-gray-500 mb-1">Less work staying can improve service; it is lost work, not a gain.</p>}
      <div className="h-[180px]">
        <Line
          data={{ labels, datasets: [line(isBook ? 'Expected book remaining' : 'Book remaining (manual)', isBook && expected ? expected.remaining : manual, '#22d3ee'), ...(isBook ? [line('Manual staircase', manual, '#94a3b8', true)] : [])] }}
          options={{
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: { legend: { display: true, position: 'top', labels: { color: '#cbd5e1', font: { size: 10 }, boxWidth: 12 } }, tooltip: { enabled: true, callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y}% of the book` } } },
            scales: {
              x: { ticks: { color: '#94a3b8', font: { size: 9 }, maxRotation: 0, autoSkipPadding: 16 }, grid: { display: false } },
              y: { min: 0, max: 100, title: { display: true, text: '% of book still here', color: '#94a3b8', font: { size: 9 } }, ticks: { color: '#94a3b8', font: { size: 9 }, stepSize: 20, callback: (v) => `${v}%` }, grid: { color: 'rgba(55,65,81,0.3)' } },
            },
          }}
        />
      </div>
      <p className="text-[10px] text-gray-500 mt-1">{isBook ? 'Line: expected share of the book still here. With bands on, each future draws its own client fates and dates, so the staircase varies.' : 'Share of the existing book still here each week.'}</p>
    </div>
  )
}
