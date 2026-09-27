// Catches a rendering error so one broken part shows a message instead of blanking the whole page.
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  label: string // what failed, in plain words
  onReset?: () => void
  compact?: boolean
  panel?: boolean // show the error where a fixed side panel was, so it is visible
}

export default class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label}]`, error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const reset = () => {
      this.setState({ error: null })
      this.props.onReset?.()
    }
    return (
      <div role="alert" className={`${this.props.panel ? 'fixed right-0 top-16 z-40 w-full sm:w-[440px] shadow-2xl bg-card' : this.props.compact ? 'm-3' : 'm-6'} rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-100`}>
        <p className="font-semibold">{this.props.label} hit an error and stopped.</p>
        <p className="mt-1 text-[12px] text-red-200/90">Your scenario is still in the page address, so reloading loses nothing.</p>
        <pre className="mt-2 whitespace-pre-wrap text-[11px] text-red-200/80">{String(error.message || error).slice(0, 400)}{'\n'}{String(error.stack || '').split('\n').slice(1, 4).join('\n')}</pre>
        <div className="mt-3 flex gap-3">
          <button className="rounded border border-red-400/50 px-3 py-1 text-[12px] hover:bg-red-500/20" onClick={reset}>Try again</button>
          <button className="rounded border border-red-400/50 px-3 py-1 text-[12px] hover:bg-red-500/20" onClick={() => location.reload()}>Reload the page</button>
        </div>
      </div>
    )
  }
}
