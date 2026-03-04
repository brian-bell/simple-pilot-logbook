import { useStatus } from '../api/queries'

export function Header() {
  const { data: status } = useStatus()

  const state = status?.state ?? 'DISCONNECTED'
  const connected = status?.connected ?? false

  let dotClass = 'w-2.5 h-2.5 rounded-full transition-colors duration-400'
  let label = 'Connecting\u2026'

  if (state === 'AIRBORNE') {
    dotClass += ' bg-accent shadow-[0_0_8px_var(--color-accent)]'
    label = 'In Flight'
  } else if (connected) {
    dotClass += ' bg-green shadow-[0_0_6px_var(--color-green)]'
    label = 'Connected'
  } else {
    dotClass += ' bg-red'
    label = 'Disconnected'
  }

  return (
    <header className="sticky top-0 z-50 h-[52px] bg-surface border-b border-border flex items-center justify-between px-6">
      <div className="flex items-center gap-2.5">
        <span className="text-xl text-accent">&#9992;</span>
        <h1 className="text-[15px] font-semibold tracking-wider uppercase text-text-primary">
          Pilot Logbook
        </h1>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-muted font-mono">{label}</span>
        <span className={dotClass} />
      </div>
    </header>
  )
}
