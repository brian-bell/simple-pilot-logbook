import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useFlights } from '../api/queries'
import type { Flight } from '../types'
import { Header } from '../components/Header'
import { ActiveFlightBanner } from '../components/ActiveFlightBanner'
import { FlightTable } from '../components/FlightTable'
import { FlightDetailModal } from '../components/FlightDetailModal'
import { EmptyState } from '../components/EmptyState'

export const Route = createFileRoute('/')({
  component: IndexPage,
})

function IndexPage() {
  const { data: flightsData, isLoading } = useFlights()
  const [selectedFlight, setSelectedFlight] = useState<Flight | null>(null)

  const flights = flightsData?.flights ?? []
  const total = flightsData?.total ?? 0

  return (
    <>
      <Header />
      <ActiveFlightBanner />

      <main className="px-6 pt-5 pb-10 max-w-[1400px] mx-auto">
        <div className="flex items-baseline gap-3 mb-3">
          <span className="text-xs font-semibold uppercase tracking-widest text-text-muted">
            Flight Log
          </span>
          <span className="font-mono text-[11px] text-text-muted">
            {total > 0 ? `${total} flight${total !== 1 ? 's' : ''}` : ''}
          </span>
        </div>

        {isLoading ? null : flights.length === 0 ? (
          <EmptyState />
        ) : (
          <FlightTable flights={flights} onSelectFlight={setSelectedFlight} />
        )}
      </main>

      <FlightDetailModal
        flight={selectedFlight}
        onClose={() => setSelectedFlight(null)}
      />
    </>
  )
}
