import { PATH_META, QUESTIONS, STATUS_LABEL, type Question } from '../../lib/questions'
import { getPath, rangeFor, setPath, statusCounts } from '../../lib/register'
import type { Assumption, Inputs, Status, Triple } from '../../lib/types'

interface Props {
  inputs: Inputs
  set: (mutate: (i: Inputs) => void) => void
}

const STATUS_STYLE: Record<Status, string> = {
  default: 'bg-gray-700/40 text-gray-400 border-gray-600',
  estimated: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  confirmed: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
}

/** Display scale for a path: percentages as whole numbers. */
const scaleOf = (path: string) => (PATH_META[path]?.unit === 'pct' ? 100 : 1)
const unitOf = (path: string) => ({ weeks: 'wk', pct: '%', x: '×', sec: 's', hours: 'h', contacts: '', fte: 'FTE' })[PATH_META[path]?.unit ?? 'x']
const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Number(x.toPrecision(3)).toString())

function Row({ path, a, set }: { path: string; a: Assumption | undefined; set: Props["set"] }) {
  const meta = PATH_META[path]
  const status: Status = a?.status ?? 'default'
  const k = scaleOf(path)
  const update = (f: (i: Inputs, cur: Assumption) => void) =>
    set((i) => {
      const cur: Assumption = i.assumptions[path] ?? { status: 'default' }
      f(i, cur)
      i.assumptions[path] = cur
    })
  const setStatus = (s: Status) =>
    update((i, cur) => {
      cur.status = s
      if (meta) {
        const v = getPath(i, path)
        cur.range = s === 'estimated' ? cur.range ?? rangeFor(path, v, 'default') : rangeFor(path, v, s)
      }
    })
  const setBound = (idx: 0 | 1 | 2, shown: number) =>
    update((i, cur) => {
      const v = shown / k
      if (idx === 1) setPath(i, path, v)
      const likely = getPath(i, path)
      const r: Triple = cur.range ? [...cur.range] : [likely, likely, likely]
      r[1] = likely
      if (idx !== 1) r[idx] = v
      cur.range = rangeFor(path, likely, cur.status === 'default' ? 'estimated' : cur.status, r)
      if (cur.status === 'default' && idx !== 1) cur.status = 'estimated'
    })
  const r = a?.range
  return (
    <div className="py-1.5 border-t border-card-border/40">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-gray-300">{meta?.label ?? path.replace('after.', '').replace('demand.', '')}</span>
        <select aria-label={`Status of ${path}`} value={status} onChange={(e) => setStatus(e.target.value as Status)}
          className={`text-[10px] rounded border px-1 py-0.5 ${STATUS_STYLE[status]}`}>
          {(['default', 'estimated', 'confirmed'] as const).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
      </div>
      {meta && r && (
        <div className="grid grid-cols-3 gap-1 mt-1">
          {([0, 1, 2] as const).map((idx) => (
            <label key={idx} className="text-[9px] text-gray-500">
              {['low', 'likely', 'high'][idx]}
              <input type="number" aria-label={`${path} ${['low', 'likely', 'high'][idx]}`} value={fmt(r[idx] * k)} step={meta.integer ? 1 : k === 100 ? 1 : 'any'}
                disabled={status === 'confirmed' && idx !== 1}
                onChange={(e) => { const x = parseFloat(e.target.value); if (Number.isFinite(x)) setBound(idx, x) }}
                className="!px-1 !py-0.5 !text-[11px] disabled:opacity-40" />
            </label>
          ))}
        </div>
      )}
      {meta && r && <p className="text-[9px] text-gray-600 mt-0.5">{unitOf(path)}{status === 'default' ? ' · generic range until someone answers' : ''}</p>}
      <input placeholder="Owner / note" aria-label={`${path} owner`} value={a?.owner ?? ''} maxLength={60}
        onChange={(e) => update((_, cur) => { cur.owner = e.target.value || undefined })}
        className="mt-1 w-full bg-transparent border-b border-card-border/50 text-[10px] text-gray-400 placeholder:text-gray-600 focus:outline-none" />
    </div>
  )
}

function QuestionBlock({ q, inputs, set }: { q: Pick<Question, 'id' | 'text' | 'sets'> & { why?: string; hint?: string }; inputs: Inputs; set: Props['set'] }) {
  const sts = q.sets.map((p) => inputs.assumptions[p]?.status ?? 'default')
  const done = sts.every((s) => s === 'confirmed') ? 'confirmed' : sts.some((s) => s !== 'default') ? 'estimated' : 'default'
  return (
    <details className="mb-1">
      <summary className="cursor-pointer text-[11px] text-gray-200 py-1 list-none flex gap-2 items-start">
        <span className={`shrink-0 mt-0.5 w-2 h-2 rounded-full ${done === 'confirmed' ? 'bg-emerald-400' : done === 'estimated' ? 'bg-amber-400' : 'bg-gray-600'}`} />
        <span><span className="text-gray-500">{q.id}</span> {q.text}</span>
      </summary>
      <div className="pl-4 pb-1">
        {q.why && <p className="text-[10px] text-gray-500">{q.why}</p>}
        {q.hint && <p className="text-[10px] text-gray-500 italic">{q.hint}</p>}
        {q.sets.map((p) => <Row key={p} path={p} a={inputs.assumptions[p]} set={set} />)}
      </div>
    </details>
  )
}

export default function AssumptionsCard({ inputs, set }: Props) {
  const c = statusCounts(inputs)
  const total = c.default + c.estimated + c.confirmed || 1
  const groups = ['Timing', 'People', 'Demand', 'Service'] as const
  return (
    <div>
      <div className="flex h-1.5 rounded overflow-hidden mb-1" aria-label="Assumption status">
        <div className="bg-emerald-400" style={{ width: `${(100 * c.confirmed) / total}%` }} />
        <div className="bg-amber-400" style={{ width: `${(100 * c.estimated) / total}%` }} />
        <div className="bg-gray-600" style={{ width: `${(100 * c.default) / total}%` }} />
      </div>
      <p className="text-[10px] text-gray-400 mb-2">
        {c.confirmed} confirmed · {c.estimated} estimated · {c.default} not asked. Each answer narrows its range; with bands on, the
        forecast narrows with it.
      </p>
      {inputs.projectQuestions.length > 0 && (
        <>
          <p className="text-[10px] font-semibold text-gray-400 uppercase mt-2 mb-1">Project questions</p>
          {inputs.projectQuestions.map((q) => <QuestionBlock key={q.id} q={q} inputs={inputs} set={set} />)}
        </>
      )}
      {groups.map((g) => (
        <div key={g}>
          <p className="text-[10px] font-semibold text-gray-400 uppercase mt-2 mb-1">{g}</p>
          {QUESTIONS.filter((q) => q.group === g).map((q) => <QuestionBlock key={q.id} q={q} inputs={inputs} set={set} />)}
        </div>
      ))}
    </div>
  )
}
