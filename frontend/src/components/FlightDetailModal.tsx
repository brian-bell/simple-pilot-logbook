import { useCallback, useEffect } from 'react'
import type { Flight } from '../types'
import { fmtDuration, fmtVS, fmtG, fmtNm, fmtAlt, fmtDate, routeLabel } from '../lib/formatters'

interface Props {
  flight: Flight | null
  onClose: () => void
}

export function FlightDetailModal({ flight, onClose }: Props) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose],
  )

  useEffect(() => {
    if (flight) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [flight, handleKeyDown])

  if (!flight) return null

  const dep = routeLabel(flight, 'departure')
  const arr = routeLabel(flight, 'arrival')
  const vs = fmtVS(flight.landing_vs_fpm)
  const { date, time } = fmtDate(flight.date)

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[200] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="bg-surface border border-border-light w-[min(580px,95vw)] max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <span className="text-[13px] font-semibold uppercase tracking-wider text-text-dim">
            {dep} &rarr; {arr}
          </span>
          <button
            className="bg-transparent border-none text-text-muted text-xl cursor-pointer px-1 leading-none hover:text-text-primary"
            aria-label="Close"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="p-5">
          <SectionTitle>Route</SectionTitle>
          <DetailGrid>
            <DetailCell label="Departure" value={flight.departure_icao || '\u2014'} />
            <DetailCell label="Arrival" value={flight.arrival_icao || '\u2014'} />
            <DetailCell label="Dep. Name" value={flight.departure_name || '\u2014'} />
            <DetailCell label="Arr. Name" value={flight.arrival_name || '\u2014'} />
            <DetailCell label="Distance" value={`${fmtNm(flight.distance_nm)} nm`} />
            <DetailCell label="Duration" value={fmtDuration(flight.elapsed_seconds)} />
          </DetailGrid>

          <SectionTitle>Aircraft</SectionTitle>
          <DetailGrid>
            <DetailCell label="Registration" value={flight.aircraft_registration || '\u2014'} />
            <DetailCell label="Type / Title" value={flight.aircraft_title || '\u2014'} />
          </DetailGrid>

          <SectionTitle>Performance</SectionTitle>
          <DetailGrid>
            <DetailCell label="Max Altitude" value={fmtAlt(flight.max_altitude_ft)} />
            <DetailCell label="Landing VS" value={vs.text} valueClass={vs.cls} />
            <DetailCell label="Landing G-Force" value={fmtG(flight.landing_g_force)} />
            <DetailCell label="Date / Time" value={`${date} ${time}`} />
          </DetailGrid>

          {flight.notes && (
            <>
              <SectionTitle>Notes</SectionTitle>
              <DetailGrid>
                <div className="bg-surface p-3.5 col-span-full">
                  <span className="block font-mono text-[13px] text-text-primary">
                    {flight.notes}
                  </span>
                </div>
              </DetailGrid>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-widest text-text-muted mt-4 mb-2 first:mt-0">
      {children}
    </p>
  )
}

function DetailGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-px bg-border border border-border max-sm:grid-cols-1">
      {children}
    </div>
  )
}

function DetailCell({
  label,
  value,
  valueClass,
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <div className="bg-surface p-3.5 odd:bg-surface-alt">
      <span className="block text-[10px] uppercase tracking-wider text-text-muted mb-0.5">
        {label}
      </span>
      <span className={`block font-mono text-[13px] text-text-primary ${valueClass || ''}`}>
        {value}
      </span>
    </div>
  )
}
