// Minimal, safe Markdown for analyst replies: headings, bold, inline code, lists, pipe tables.
// Builds React elements only (no innerHTML), so model output can never inject markup.
import type { ReactNode } from 'react'

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const t = m[0]
    out.push(t.startsWith('**') ? <b key={`${key}-${i++}`} className="text-white">{t.slice(2, -2)}</b> : <code key={`${key}-${i++}`} className="px-1 rounded bg-black/30 text-brand-300">{t.slice(1, -1)}</code>)
    last = m.index + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export default function Markdown({ text }: { text: string }) {
  const lines = String(text ?? '').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split('|').map((c) => c.trim()))
        i++
      }
      blocks.push(
        <div key={`t${i}`} className="overflow-x-auto my-2">
          <table className="text-[11px] border-collapse">
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className={ri === 0 ? 'text-gray-400' : 'border-t border-card-border/60'}>
                  {r.map((c, ci) => <td key={ci} className="px-2 py-0.5">{inline(c, `t${i}-${ri}-${ci}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }
    if (/^\s*[-*] /.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*] /.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*] /, ''))
      blocks.push(<ul key={`u${i}`} className="list-disc pl-5 my-1 space-y-0.5">{items.map((it, k) => <li key={k}>{inline(it, `u${i}-${k}`)}</li>)}</ul>)
      continue
    }
    if (/^\s*\d+\. /.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\. /.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\. /, ''))
      blocks.push(<ol key={`o${i}`} className="list-decimal pl-5 my-1 space-y-0.5">{items.map((it, k) => <li key={k}>{inline(it, `o${i}-${k}`)}</li>)}</ol>)
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) blocks.push(<p key={`h${i}`} className="font-semibold text-white mt-2">{inline(h[2], `h${i}`)}</p>)
    else if (line.trim()) blocks.push(<p key={`p${i}`} className="my-1">{inline(line, `p${i}`)}</p>)
    i++
  }
  return <div className="text-[13px] leading-relaxed text-gray-200">{blocks}</div>
}
