import { useStatus } from '../api/queries'
import { fmtDuration } from '../lib/formatters'

export function ActiveFlightBanner() {
  const { data: status } = useStatus()

  if (status?.state !== 'AIRBORNE' || !status.current_flight) return null

  const cf = status.current_flight
  const aircraft =
    cf.aircraft_registration ||
    cf.aircraft_title?.split(' ').slice(0, 3).join(' ') ||
    '\u2014'
  const altitude =
    cf.altitude_ft != null ? Math.round(cf.altitude_ft).toLocaleString() : '\u2014'

  return (
    <div className="bg-banner-bg border-b border-banner-border px-6 h-12 flex items-center">
      <div className="flex items-center gap-7 flex-wrap">
        <span className="flex items-baseline gap-1.5">
          <span className="text-[11px] uppercase tracking-widest text-text-muted">From</span>
          <strong className="font-mono text-[13px] text-accent">
            {cf.departure_icao || '\u2014'}
          </strong>
        </span>
        <span className="text-base text-text-muted">&#10132;</span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-[11px] uppercase tracking-widest text-text-muted">Aircraft</span>
          <strong className="font-mono text-[13px] text-accent">{aircraft}</strong>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-[11px] uppercase tracking-widest text-text-muted">Altitude</span>
          <strong className="font-mono text-[13px] text-accent">{altitude}</strong>
          <span className="text-[11px] text-text-muted">ft</span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-[11px] uppercase tracking-widest text-text-muted">Elapsed</span>
          <strong className="font-mono text-[13px] text-accent">
            {fmtDuration(cf.elapsed_seconds)}
          </strong>
        </span>
      </div>
    </div>
  )
}
