export function EmptyState() {
  return (
    <div className="text-center py-20 px-6 text-text-muted">
      <span className="text-5xl block mb-4 opacity-30">&#9992;</span>
      <p className="mb-1.5">No flights recorded yet.</p>
      <p className="text-xs text-text-muted opacity-70">
        Flights are automatically captured from Microsoft Flight Simulator via SimConnect.
      </p>
    </div>
  )
}
