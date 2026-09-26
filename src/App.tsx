import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import AgentPanel from './components/agent/AgentPanel'
import { CapacityChart, ServiceChart } from './components/charts/Charts'
import NumberInput from './components/inputs/NumberInput'
import SliderInput from './components/inputs/SliderInput'
import ResultCard from './components/results/ResultCard'
import { download, toCsv } from './lib/csv'
import { cloneDefaults } from './lib/defaults'
import { run } from './lib/engine'
import { getGradeTable, scoreToGrade } from './lib/grade'
import type { McBands } from './lib/montecarlo'
import { commitOf, decode, toHash } from './lib/share'
import { codeUrl, COMMIT, ENGINE_VERSION, REPO, SHORT } from './lib/version'
import type { Inputs, RunResult, Triple } from './lib/types'

const WIKI_ARTICLE = 'https://wiki.wfmlabs.org/wiki/Service_Level_During_Work_Migration'
const WIKI_PACK = 'https://wiki.wfmlabs.org/wiki/Wiki:Packs/Migration_Service-Level_Simulation'

function Card({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="bg-card rounded-lg border border-card-border overflow-hidden">
      <div className="bg-brand-500/20 border-b border-brand-500/30 px-3 py-1.5 flex items-center justify-between">
        <h2 className="text-[10px] font-bold text-brand-400 uppercase tracking-wider">{title}</h2>
        {right}
      </div>
      <div className="p-3">{children}</div>
    </div>
  )
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex items-start gap-2 mb-3 cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-cyan-500" />
      <span>
        <span className="text-xs font-medium text-gray-300">{label}</span>
        {hint && <span className="block text-[10px] text-gray-500">{hint}</span>}
      </span>
    </label>
  )
}

function TripleInput({ label, value, onChange, step, format }: { label: string; value: Triple; onChange: (v: Triple) => void; step: number; format?: (x: number) => string }) {
  const f = format ?? ((x: number) => String(x))
  return (
    <div className="mb-3">
      <p className="text-xs font-medium text-gray-300 mb-1">{label} <span className="text-[10px] text-gray-500">low · likely · high</span></p>
      <div className="grid grid-cols-3 gap-1">
        {value.map((v, i) => (
          <input key={i} type="number" step={step} value={v} title={f(v)}
            onChange={(e) => { const n = [...value] as Triple; n[i] = parseFloat(e.target.value) || 0; onChange(n) }} />
        ))}
      </div>
    </div>
  )
}

const pct = (x: number, d = 0) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—')
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—')

function summarise(r: RunResult & { targets: { voice: number; chat: number } }) {
  const graded = r.weeks.filter((w) => Number.isFinite(w.score))
  const worst = graded.reduce((a, w) => (w.score < a.score ? w : a), graded[0] ?? r.weeks[0])
  const below = (k: 'voice' | 'chat', t: number) => r.weeks.filter((w) => w[k].scored && w[k].sl < t - 1e-6).length
  const emailLate = r.weeks.filter((w) => w.email.scored && w.email.timeliness < 1 - 1e-6).length
  const util = Math.max(0, ...r.weeks.map((w) => (Number.isFinite(w.utilisation) ? w.utilisation : 0)))
  const gapWeek = r.weeks.reduce((a, w) => (w.fteReq - w.fteAvail > a.fteReq - a.fteAvail ? w : a), r.weeks[0])
  const backlog = Math.max(0, ...r.weeks.map((w) => w.email.backlogDays))
  const idle = r.weeks.reduce((s, w) => s + w.borrowedIdleHours, 0)
  const worstChannel = !worst
    ? ''
    : [
        worst.voice.scored ? { k: `Voice ${pct(worst.voice.sl)}`, a: worst.voice.sl / r.targets.voice } : null,
        worst.chat.scored ? { k: `Chat ${pct(worst.chat.sl)}`, a: worst.chat.sl / r.targets.chat } : null,
        worst.email.scored ? { k: `Email ${pct(worst.email.timeliness)} on time`, a: worst.email.timeliness } : null,
      ].filter((x): x is { k: string; a: number } => !!x).sort((x, y) => x.a - y.a)[0]?.k ?? ''
  return { worst, emailLate, util, gapWeek, backlog, idle, below, worstChannel }
}

export default function App() {
  const [inputs, setInputs] = useState<Inputs>(() => decode(window.location.hash) ?? cloneDefaults())
  const [saved, setSaved] = useState<Inputs | null>(null)
  const [showCompare, setShowCompare] = useState(true)
  const [bands, setBands] = useState<McBands | null>(null)
  const [mcState, setMcState] = useState<'idle' | 'running' | 'partial' | 'done'>('idle')
  const [showInfo, setShowInfo] = useState(false)
  const [showTable, setShowTable] = useState(false)
  const [copied, setCopied] = useState(false)
  const workerRef = useRef<Worker | null>(null)
  const [showAgent, setShowAgent] = useState(false)
  const [undo, setUndo] = useState<{ prev: Inputs; label: string } | null>(null)
  const [linkCommit] = useState(() => commitOf(window.location.hash))
  const inputsRef = useRef(inputs)
  inputsRef.current = inputs
  const onAgentApply = useCallback((next: Inputs, label: string) => {
    setUndo({ prev: inputsRef.current, label })
    setInputs(next)
  }, [])
  const genRef = useRef(0)

  const set = (mutate: (i: Inputs) => void) =>
    setInputs((prev) => {
      const next = structuredClone(prev)
      mutate(next)
      return next
    })

  const result = useMemo(() => run(inputs), [inputs])
  const compare = useMemo(() => (saved && showCompare ? run(saved) : null), [saved, showCompare])
  const s = useMemo(() => summarise({ ...result, targets: { voice: inputs.channels.voice.slTarget, chat: inputs.channels.chat.slTarget } }), [result, inputs.channels.voice.slTarget, inputs.channels.chat.slTarget])

  // keep the URL in step with the scenario (debounced)
  useEffect(() => {
    const t = setTimeout(() => history.replaceState(null, '', `#${toHash(inputs)}`), 300)
    return () => clearTimeout(t)
  }, [inputs])

  // Monte Carlo in a worker, debounced; stale answers are dropped by generation id
  useEffect(() => {
    if (!inputs.uncertainty.enabled) {
      setBands(null)
      setMcState('idle')
      return
    }
    const t = setTimeout(() => {
      if (!workerRef.current) {
        workerRef.current = new Worker(new URL('./workers/mc.worker.ts', import.meta.url), { type: 'module' })
        workerRef.current.onmessage = (e: MessageEvent<{ gen: number; done: boolean; bands: McBands }>) => {
          if (e.data.gen !== genRef.current) return
          setBands(e.data.bands)
          setMcState(e.data.done ? 'done' : 'partial')
        }
      }
      genRef.current += 1
      setMcState('running')
      workerRef.current.postMessage({ inputs, gen: genRef.current })
    }, 400)
    return () => clearTimeout(t)
  }, [inputs])

  useEffect(() => () => workerRef.current?.terminate(), [])

  const worstGrade = Number.isFinite(s.worst?.score) ? scoreToGrade(s.worst.score) : null
  const mcGrade = bands ? scoreToGrade(bands.cleanShare) : null
  const ch = inputs.channels

  const copyLink = async () => {
    const url = `${location.origin}${location.pathname}#${toHash(inputs)}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt('Copy this link', url)
    }
  }

  return (
    <div className="min-h-screen bg-darker">
      {/* ═══════ Top bar ═══════ */}
      <div className="border-b border-card-border bg-card/50 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-[1600px] mx-auto px-4 py-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-7 h-7 rounded bg-brand-500 flex items-center justify-center font-bold text-xs text-white shrink-0">W</div>
            <div className="min-w-0">
              <h1 className="text-sm font-bold text-white leading-tight">Migration Scenario Modeler</h1>
              <p className="text-[9px] text-gray-500">WFM Labs</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {worstGrade && (
              <div className="text-center">
                <p className="text-[8px] text-gray-500 uppercase">Worst week</p>
                <p className="text-sm font-bold" style={{ color: worstGrade.color }}>{worstGrade.grade}</p>
              </div>
            )}
            {mcGrade && (
              <div className="text-center px-3 py-1 rounded bg-brand-500/10 border border-brand-500/30">
                <p className="text-[8px] text-gray-400 uppercase">Futures with no breach</p>
                <p className="text-sm font-bold" style={{ color: mcGrade.color }}>{mcGrade.grade}</p>
              </div>
            )}
            <button onClick={() => setShowAgent(true)} className="text-xs px-3 py-1.5 rounded bg-brand-500 hover:bg-brand-400 text-white font-semibold">Ask the analyst</button>
            <button onClick={() => setShowInfo(true)} className="ml-1 w-6 h-6 rounded-full border border-gray-600 text-gray-500 hover:text-brand-400 hover:border-brand-400 transition-colors text-xs font-bold flex items-center justify-center" title="How it works">?</button>
          </div>
        </div>
      </div>

      <main className="max-w-[1600px] mx-auto px-4 py-4">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* ═══════ Inputs ═══════ */}
          <div className="lg:col-span-3 space-y-3">
            <Card title="Channels">
              <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1">Voice</p>
              <NumberInput label="Weekly contacts" value={ch.voice.volume} step={100} min={0} onChange={(v) => set((i) => { i.channels.voice.volume = v })} />
              <div className="grid grid-cols-3 gap-2">
                <NumberInput label="AHT (s)" value={ch.voice.aht} step={10} min={1} onChange={(v) => set((i) => { i.channels.voice.aht = Math.max(1, v) })} />
                <NumberInput label="Target %" value={Math.round(ch.voice.slTarget * 100)} step={1} min={1} max={99} onChange={(v) => set((i) => { i.channels.voice.slTarget = Math.min(0.99, Math.max(0.01, v / 100)) })} />
                <NumberInput label="In (s)" value={ch.voice.slSeconds} step={5} min={1} onChange={(v) => set((i) => { i.channels.voice.slSeconds = Math.max(1, v) })} />
              </div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1 mt-1">Chat</p>
              <div className="grid grid-cols-2 gap-2">
                <NumberInput label="Weekly chats" value={ch.chat.volume} step={100} min={0} onChange={(v) => set((i) => { i.channels.chat.volume = v })} />
                <NumberInput label="Concurrency" value={ch.chat.concurrency} step={0.5} min={1} max={6} onChange={(v) => set((i) => { i.channels.chat.concurrency = Math.max(1, v) })} />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <NumberInput label="AHT (s)" value={ch.chat.aht} step={10} min={1} onChange={(v) => set((i) => { i.channels.chat.aht = Math.max(1, v) })} />
                <NumberInput label="Target %" value={Math.round(ch.chat.slTarget * 100)} step={1} min={1} max={99} onChange={(v) => set((i) => { i.channels.chat.slTarget = Math.min(0.99, Math.max(0.01, v / 100)) })} />
                <NumberInput label="In (s)" value={ch.chat.slSeconds} step={5} min={1} onChange={(v) => set((i) => { i.channels.chat.slSeconds = Math.max(1, v) })} />
              </div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1 mt-1">Email (backlog)</p>
              <div className="grid grid-cols-3 gap-2">
                <NumberInput label="Weekly" value={ch.email.volume} step={100} min={0} onChange={(v) => set((i) => { i.channels.email.volume = v })} />
                <NumberInput label="AHT (s)" value={ch.email.aht} step={10} min={1} onChange={(v) => set((i) => { i.channels.email.aht = Math.max(1, v) })} />
                <NumberInput label="Target (days)" value={ch.email.targetDays} step={0.5} min={0.25} onChange={(v) => set((i) => { i.channels.email.targetDays = Math.max(0.25, v) })} />
              </div>
              <p className="text-[10px] text-gray-500">One blended team serves Voice first, then Chat; Email takes what is left.</p>
            </Card>

            <Card title="Team">
              <NumberInput label="Starting headcount (FTE)" value={inputs.pool.fte} step={1} min={0} onChange={(v) => set((i) => { i.pool.fte = Math.max(0, v) })} />
              <SliderInput label="Shrinkage (total)" value={inputs.pool.shrinkage} min={0} max={0.6} step={0.01} format="percent" onChange={(v) => set((i) => { i.pool.shrinkage = v })} />
              <SliderInput label="Base attrition (annual)" value={inputs.attrition.annual} min={0} max={0.8} step={0.01} format="percent" onChange={(v) => set((i) => { i.attrition.annual = v })} />
              <div className="grid grid-cols-2 gap-2">
                <NumberInput label="Paid hours / week" value={inputs.pool.paidHours} step={0.5} min={1} onChange={(v) => set((i) => { i.pool.paidHours = Math.max(1, v) })} />
                <NumberInput label="Open hours / week" value={inputs.pool.openHours} step={1} min={1} onChange={(v) => set((i) => { i.pool.openHours = Math.max(1, v) })} />
              </div>
            </Card>

            <Card title="Freeze period">
              <div className="grid grid-cols-2 gap-2">
                <NumberInput label="Starts week" value={inputs.freeze.startWeek} step={1} min={0} onChange={(v) => set((i) => { i.freeze.startWeek = Math.max(0, Math.round(v)) })} />
                <NumberInput label="Ends week" value={inputs.freeze.endWeek} step={1} min={0} onChange={(v) => set((i) => { i.freeze.endWeek = Math.max(0, Math.round(v)) })} />
              </div>
              <SliderInput label="Tension effect on attrition" value={inputs.attrition.tensionMult} min={1} max={4} step={0.1} format="multiplier" onChange={(v) => set((i) => { i.attrition.tensionMult = v })} />
              <Toggle label="Backfill leavers before the freeze" checked={inputs.freeze.backfillBefore} onChange={(v) => set((i) => { i.freeze.backfillBefore = v })} hint="During and after the freeze nobody is replaced; no work is moved until it ends." />
            </Card>

            <Card title="Demand">
              <SliderInput label="Natural runoff (per week)" value={inputs.demand.runoffPctWeek} min={0} max={0.05} step={0.001} format="percent" onChange={(v) => set((i) => { i.demand.runoffPctWeek = v })} />
              <NumberInput label="Runoff starts week (blank = freeze start)" value={inputs.demand.runoffStartWeek ?? inputs.freeze.startWeek} step={1} min={0} onChange={(v) => set((i) => { i.demand.runoffStartWeek = Math.max(0, Math.round(v)) })} />
              <Toggle label="Taking on new demand" checked={inputs.demand.intakeOn} onChange={(v) => set((i) => { i.demand.intakeOn = v })} hint="On: new work replaces what runs off, at the rate below." />
              {inputs.demand.intakeOn && <SliderInput label="New demand replaces runoff at" value={inputs.demand.intakePct} min={0} max={1.5} step={0.05} format="percent" onChange={(v) => set((i) => { i.demand.intakePct = v })} />}
              <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1">Step-downs (e.g. contract expiries)</p>
              {inputs.demand.stepDowns.map((sd, k) => (
                <div key={k} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
                  <NumberInput label="Week" value={sd.week} step={1} min={0} onChange={(v) => set((i) => { i.demand.stepDowns[k].week = Math.max(0, Math.round(v)) })} />
                  <NumberInput label="% of book" value={Math.round(sd.pct * 100)} step={1} min={0} max={100} onChange={(v) => set((i) => { i.demand.stepDowns[k].pct = Math.min(1, Math.max(0, v / 100)) })} />
                  <button className="mb-3 text-gray-500 hover:text-red-400 text-xs" onClick={() => set((i) => { i.demand.stepDowns.splice(k, 1) })}>✕</button>
                </div>
              ))}
              <button className="text-[11px] text-brand-400 hover:text-brand-300" onClick={() => set((i) => { i.demand.stepDowns.push({ week: i.freeze.startWeek + 4, pct: 0.1 }) })}>+ Add step-down</button>
            </Card>

            <Card title="After the freeze">
              <SliderInput label="Attrition after announcement" value={inputs.attrition.postMult} min={1} max={6} step={0.1} format="multiplier" onChange={(v) => set((i) => { i.attrition.postMult = v })} />
              <div className="grid grid-cols-2 gap-2">
                <NumberInput label="Absence surge (pts)" value={Math.round(inputs.after.surgePts * 100)} step={1} min={0} max={30} onChange={(v) => set((i) => { i.after.surgePts = Math.max(0, v / 100) })} />
                <NumberInput label="…for weeks" value={inputs.after.surgeWeeks} step={1} min={0} onChange={(v) => set((i) => { i.after.surgeWeeks = Math.max(0, Math.round(v)) })} />
              </div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1">Waves out (share of the book; 100% = fully moved)</p>
              {inputs.after.waves.map((wv, k) => (
                <div key={k} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
                  <NumberInput label="Weeks after freeze" value={wv.weeksAfterFreeze} step={1} min={0} onChange={(v) => set((i) => { i.after.waves[k].weeksAfterFreeze = Math.max(0, Math.round(v)) })} />
                  <NumberInput label="% of book" value={Math.round(wv.pct * 100)} step={5} min={0} max={100} onChange={(v) => set((i) => { i.after.waves[k].pct = Math.min(1, Math.max(0, v / 100)) })} />
                  <button className="mb-3 text-gray-500 hover:text-red-400 text-xs" onClick={() => set((i) => { i.after.waves.splice(k, 1) })}>✕</button>
                </div>
              ))}
              {inputs.after.waves.length < 4 && <button className="text-[11px] text-brand-400 hover:text-brand-300 mb-2" onClick={() => set((i) => { i.after.waves.push({ weeksAfterFreeze: 20, pct: 0.2 }) })}>+ Add wave</button>}
              <p className="text-[10px] text-gray-500 mb-2">Total: {pct(inputs.after.waves.reduce((a, w) => a + w.pct, 0))} of the book. Staff move out in the same proportion.</p>
              <div className="grid grid-cols-2 gap-2">
                <NumberInput label="Training h / transferee" value={inputs.after.trainingHours} step={4} min={0} onChange={(v) => set((i) => { i.after.trainingHours = Math.max(0, v) })} />
                <NumberInput label="…over weeks before" value={inputs.after.trainingWeeks} step={1} min={1} onChange={(v) => set((i) => { i.after.trainingWeeks = Math.max(1, Math.round(v)) })} />
              </div>
              <Toggle label="Release surplus staff" checked={inputs.after.releasesOn} onChange={(v) => set((i) => { i.after.releasesOn = v })} hint="After the notice period, staff above the coming weeks' need are released." />
              {inputs.after.releasesOn && (
                <div className="grid grid-cols-2 gap-2">
                  <NumberInput label="Notice (weeks)" value={inputs.after.noticeWeeks} step={1} min={0} onChange={(v) => set((i) => { i.after.noticeWeeks = Math.max(0, Math.round(v)) })} />
                  <NumberInput label="Buffer %" value={Math.round(inputs.after.releaseBuffer * 100)} step={1} min={0} onChange={(v) => set((i) => { i.after.releaseBuffer = Math.max(0, v / 100) })} />
                </div>
              )}
            </Card>

            <Card title="Borrowed capacity">
              <NumberInput label="Borrowed FTE" value={inputs.borrowed.fte} step={1} min={0} onChange={(v) => set((i) => { i.borrowed.fte = Math.max(0, v) })} />
              <div className="grid grid-cols-3 gap-2">
                <NumberInput label="From week" value={inputs.borrowed.startWeek} step={1} min={0} onChange={(v) => set((i) => { i.borrowed.startWeek = Math.max(0, Math.round(v)) })} />
                <NumberInput label="To week" value={inputs.borrowed.endWeek} step={1} min={0} onChange={(v) => set((i) => { i.borrowed.endWeek = Math.max(0, Math.round(v)) })} />
                <NumberInput label="AHT ×" value={inputs.borrowed.ahtPenalty} step={0.05} min={1} onChange={(v) => set((i) => { i.borrowed.ahtPenalty = Math.max(1, v) })} />
              </div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1">Can handle</p>
              <div className="flex gap-3">
                {(['voice', 'chat', 'email'] as const).map((c) => (
                  <Toggle key={c} label={c[0].toUpperCase() + c.slice(1)} checked={inputs.borrowed.eligible[c]} onChange={(v) => set((i) => { i.borrowed.eligible[c] = v })} />
                ))}
              </div>
            </Card>

            <Card title="Advanced">
              <NumberInput label="Horizon (weeks)" value={inputs.horizonWeeks} step={1} min={13} max={78} onChange={(v) => set((i) => { i.horizonWeeks = Math.min(78, Math.max(13, Math.round(v))) })} />
              <SliderInput label="Schedule fit to demand" value={inputs.profile.scheduleFit} min={0} max={1} step={0.05} format="percent" onChange={(v) => set((i) => { i.profile.scheduleFit = v })} />
              <p className="text-[10px] text-gray-500 mb-3">Intraday shape: peak / shoulder / off-peak carry {inputs.profile.volumeShare.map((x) => pct(x)).join(' / ')} of contacts in {inputs.profile.hourShare.map((x) => pct(x)).join(' / ')} of open hours.</p>
              <Toggle label="Show uncertainty bands (Monte Carlo)" checked={inputs.uncertainty.enabled} onChange={(v) => set((i) => { i.uncertainty.enabled = v })} hint="Draws the inputs below from ranges; bands show the 10th–90th percentile of futures." />
              {inputs.uncertainty.enabled && (
                <>
                  <TripleInput label="Freeze length (weeks)" value={inputs.uncertainty.freezeLength} step={1} onChange={(v) => set((i) => { i.uncertainty.freezeLength = v })} />
                  <TripleInput label="Tension effect (×)" value={inputs.uncertainty.tensionMult} step={0.1} onChange={(v) => set((i) => { i.uncertainty.tensionMult = v })} />
                  <TripleInput label="Attrition after announcement (×)" value={inputs.uncertainty.postMult} step={0.1} onChange={(v) => set((i) => { i.uncertainty.postMult = v })} />
                  <TripleInput label="Absence surge (fraction)" value={inputs.uncertainty.surgePts} step={0.01} onChange={(v) => set((i) => { i.uncertainty.surgePts = v })} />
                  <TripleInput label="Runoff per week (fraction)" value={inputs.uncertainty.runoffPctWeek} step={0.001} onChange={(v) => set((i) => { i.uncertainty.runoffPctWeek = v })} />
                  <NumberInput label="Futures to simulate" value={inputs.uncertainty.draws} step={250} min={250} max={5000} onChange={(v) => set((i) => { i.uncertainty.draws = Math.min(5000, Math.max(250, Math.round(v))) })} />
                </>
              )}
              <button className="text-[11px] text-gray-400 hover:text-brand-400" onClick={() => { setInputs(cloneDefaults()); setSaved(null) }}>Reset to the demo scenario</button>
            </Card>
          </div>

          {/* ═══════ Results ═══════ */}
          <div className="lg:col-span-9 space-y-4 lg:sticky lg:top-14 lg:self-start lg:max-h-[calc(100vh-4.5rem)] lg:overflow-y-auto lg:pr-1">
            {linkCommit && linkCommit !== SHORT && linkCommit !== 'unknown' && SHORT !== 'unknown' && (
              <div className="text-[11px] text-sky-200 bg-sky-500/10 border border-sky-500/30 rounded px-3 py-1.5">
                This link was made with engine commit <code>{linkCommit}</code>; you are on <code>{SHORT}</code>, so results may differ slightly.{' '}
                <a className="underline" href={codeUrl(linkCommit)} target="_blank" rel="noreferrer">View that version’s code on GitHub</a>
              </div>
            )}
            {undo && (
              <div className="text-[11px] text-emerald-200 bg-emerald-500/10 border border-emerald-500/30 rounded px-3 py-1.5 flex items-center justify-between gap-2">
                <span>The analyst put scenario “{undo.label}” on screen.</span>
                <span className="flex gap-3">
                  <button className="underline" onClick={() => { setInputs(undo.prev); setUndo(null) }}>Undo</button>
                  <button className="text-emerald-300/70" onClick={() => setUndo(null)}>Keep</button>
                </span>
              </div>
            )}
            {result.warnings.map((w) => (
              <div key={w} className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-3 py-1.5">{w}</div>
            ))}
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
              {worstGrade && (
                <div className="rounded-lg border p-3 text-center bg-brand-500/10 border-brand-500/30">
                  <p className="text-[10px] text-gray-400 uppercase tracking-wider">Worst week · W{s.worst.week}</p>
                  <p className="text-3xl font-bold" style={{ color: worstGrade.color }}>{worstGrade.grade}</p>
                  <p className="text-[10px] text-gray-400">{worstGrade.rating} · {s.worstChannel}</p>
                </div>
              )}
              <ResultCard label="Weeks below target" sublabel="Voice · Chat · Email" value={`${s.below('voice', ch.voice.slTarget)} · ${s.below('chat', ch.chat.slTarget)} · ${s.emailLate}`} />
              <ResultCard label="Peak utilisation" sublabel="Work offered ÷ capacity" value={pct(s.util)} accent={s.util > 1} />
              <ResultCard label="Largest FTE gap" sublabel={`Week ${s.gapWeek.week}`} value={f1(Math.max(0, s.gapWeek.fteReq - s.gapWeek.fteAvail))} />
              <ResultCard label="Worst email backlog" sublabel={`Target ${ch.email.targetDays} day(s)`} value={`${f1(s.backlog)} d`} />
              {bands ? (
                <ResultCard label="Freeze ends (futures)" sublabel="10th · 50th · 90th pct" value={`W${bands.freezeEnd.p10} · W${bands.freezeEnd.p50} · W${bands.freezeEnd.p90}`} />
              ) : (
                <ResultCard label="Idle borrowed hours" sublabel="Borrowed staff with nothing eligible" value={f1(s.idle)} />
              )}
            </div>

            <Card
              title="Service by week"
              right={
                <span className="text-[10px] text-gray-400">
                  {inputs.uncertainty.enabled
                    ? mcState === 'done' ? `Bands: 10th–90th percentile of ${bands?.draws ?? 0} futures · line: most-likely inputs · ${pct(bands?.cleanShare ?? NaN)} of futures never breach` : 'Simulating futures…'
                    : 'Most-likely inputs'}
                </span>
              }
            >
              <ServiceChart result={result} compare={compare} bands={bands} targets={{ voice: ch.voice.slTarget, chat: ch.chat.slTarget }} />
            </Card>

            <Card title="Capacity by week">
              <CapacityChart result={result} compare={compare} bands={bands} />
              <p className="text-[10px] text-gray-500 mt-2">Available FTE counts productive time (after shrinkage, the absence surge and pre-wave training) plus borrowed staff, in headcount at base shrinkage. Required FTE is what meets every target that week.</p>
            </Card>

            <div className="flex flex-wrap gap-2 items-center">
              <button onClick={() => setSaved(structuredClone(inputs))} className="text-xs px-3 py-1.5 rounded border border-brand-500/50 text-brand-400 hover:bg-brand-500/10">
                {saved ? 'Replace scenario A with current' : 'Save current as scenario A'}
              </button>
              {saved && (
                <>
                  <Toggle label="Overlay scenario A (dashed)" checked={showCompare} onChange={setShowCompare} />
                  <button onClick={() => setInputs(structuredClone(saved))} className="text-xs px-3 py-1.5 rounded border border-card-border text-gray-300 hover:text-white">Restore A</button>
                </>
              )}
              <button onClick={copyLink} className="text-xs px-3 py-1.5 rounded border border-card-border text-gray-300 hover:text-white">{copied ? 'Link copied' : 'Copy share link'}</button>
              <button onClick={() => download('migration-scenario.csv', toCsv(result))} className="text-xs px-3 py-1.5 rounded border border-card-border text-gray-300 hover:text-white">Export CSV</button>
              <button onClick={() => setShowTable(!showTable)} className="text-xs px-3 py-1.5 rounded border border-card-border text-gray-300 hover:text-white">{showTable ? 'Hide' : 'Show'} weekly table</button>
            </div>

            {showTable && (
              <Card title="Weekly detail">
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px] font-mono">
                    <thead className="text-gray-400">
                      <tr className="text-right">
                        {['Wk', 'Phase', 'Heads', 'Avail', 'Req', 'Voice', 'Chat', 'Email', 'Backlog d', 'Util', 'Grade'].map((h) => <th key={h} className="px-2 py-1 font-medium">{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {result.weeks.map((w) => {
                        const g = Number.isFinite(w.score) ? scoreToGrade(w.score) : null
                        return (
                          <tr key={w.week} className="text-right text-gray-300 border-t border-card-border/50">
                            <td className="px-2 py-0.5">{w.week}</td>
                            <td className="px-2 py-0.5 text-gray-500">{w.phase}</td>
                            <td className="px-2 py-0.5">{f1(w.heads)}</td>
                            <td className="px-2 py-0.5">{f1(w.fteAvail)}</td>
                            <td className="px-2 py-0.5">{f1(w.fteReq)}</td>
                            <td className="px-2 py-0.5">{pct(w.voice.sl)}</td>
                            <td className="px-2 py-0.5">{pct(w.chat.sl)}</td>
                            <td className="px-2 py-0.5">{pct(w.email.timeliness)}</td>
                            <td className="px-2 py-0.5">{w.email.backlogDays.toFixed(2)}</td>
                            <td className="px-2 py-0.5">{pct(w.utilisation)}</td>
                            <td className="px-2 py-0.5 font-bold" style={{ color: g?.color }}>{g?.grade ?? '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>
        </div>

        <div className="mt-6 pt-3 border-t border-card-border text-center">
          <p className="text-[9px] text-gray-600">WFM Labs calculators are for demonstration purposes only. <a href="https://wfmlabs.com" className="text-brand-500 hover:text-brand-400">wfmlabs.com</a></p>
          <p className="text-[9px] text-gray-600 mt-1">Engine v{ENGINE_VERSION} · commit <a className="text-brand-500 hover:text-brand-400" href={codeUrl(COMMIT)} target="_blank" rel="noreferrer">{SHORT}</a> · <a className="text-brand-500 hover:text-brand-400" href={REPO} target="_blank" rel="noreferrer">source on GitHub</a></p>
        </div>
      </main>

      <AgentPanel open={showAgent} onClose={() => setShowAgent(false)} inputs={inputs} result={result} onApply={onAgentApply} />

      {showInfo && (
        <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4" onClick={() => setShowInfo(false)}>
          <div className="bg-card border border-card-border rounded-lg max-w-2xl w-full max-h-[85vh] overflow-y-auto p-5 text-sm text-gray-300 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-base font-bold text-white">How it works</h2>
              <button onClick={() => setShowInfo(false)} className="text-gray-500 hover:text-white">✕</button>
            </div>
            <p>When work moves from one site or team to another, service is rarely lost at the end state. It is lost in the weeks between, when staff leave before the work does. This modeler walks a blended team through those weeks.</p>
            <ul className="list-disc pl-5 space-y-1 text-[13px]">
              <li><b>Freeze.</b> No work moves and leavers are not replaced. Attrition runs at the base rate times the tension effect.</li>
              <li><b>Demand.</b> The existing book runs off each week and at any step-downs; new demand can replace it if intake is on.</li>
              <li><b>After the freeze.</b> Attrition rises again, absence surges for a period, and staff due to move lose productive hours to training in the weeks before their wave. Each wave moves its share of the work, its email backlog and the same share of staff.</li>
              <li><b>Service.</b> Each week, Voice gets the agents it needs first (Erlang C across a peak, shoulder and off-peak profile), then Chat (Erlang C with concurrency), and Email is worked from what is left, carrying a backlog. Spare time returns to Voice and Chat.</li>
              <li><b>Borrowed capacity</b> helps only the channels it is eligible for, and is slower by its AHT multiplier.</li>
              <li><b>Uncertainty.</b> With bands on, the freeze length, the attrition effects, the absence surge and the runoff are drawn from their ranges thousands of times (seeded, so comparisons are fair). The line always shows the most-likely inputs.</li>
            </ul>
            <p className="text-[13px]"><b>Grades</b> use the same scale as the Risk-Rated Capacity Planner. Each week is graded on its worst channel against target and the capacity headroom (most-likely inputs). With bands on, the header also grades the share of futures that get through every week without missing a target.</p>
            <table className="w-full text-[11px]">
              <tbody>
                {getGradeTable().map((g) => (
                  <tr key={g.grade} className="border-t border-card-border/50">
                    <td className="py-0.5 pr-2 font-bold" style={{ color: g.color }}>{g.grade}</td>
                    <td className="py-0.5 pr-2 text-gray-400">{g.deterministic}</td>
                    <td className="py-0.5 text-gray-500">{g.probabilistic}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[13px]"><b>Limits.</b> Erlang C assumes nobody abandons, so under overload service is shown near zero where in reality callers hang up; read utilisation alongside it. Weeks where a channel has almost no work left are not graded. The figures are illustrations of the inputs you give, not forecasts.</p>
            <p className="text-[13px]">Method and background: <a className="text-brand-400 hover:underline" href={WIKI_ARTICLE} target="_blank" rel="noreferrer">Service Level During Work Migration</a> · <a className="text-brand-400 hover:underline" href={WIKI_PACK} target="_blank" rel="noreferrer">Migration Service-Level Simulation pack</a></p>
          </div>
        </div>
      )}
    </div>
  )
}
