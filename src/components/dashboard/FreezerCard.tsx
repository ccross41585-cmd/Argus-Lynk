import { StatusPill } from '../StatusPill'

type FreezerCardProps = {
  temperature: string
  safeRange: string
  node: 'Online' | 'Offline'
  lastUpdated: string
  alertState: 'Normal' | 'Warning' | 'Critical'
  onViewDetails: () => void
}

export function FreezerCard({
  temperature,
  safeRange,
  node,
  lastUpdated,
  alertState,
  onViewDetails,
}: FreezerCardProps) {
  const tone = alertState === 'Critical' ? 'danger' : alertState === 'Warning' ? 'warning' : 'info'

  return (
    <section className="command-card command-card--freezer" id="freezer">
      <div className="command-card__header">
        <div>
          <p className="eyebrow">Freezer</p>
          <h2>Cold storage watch</h2>
        </div>
        <StatusPill tone={tone}>{alertState}</StatusPill>
      </div>

      <div className="command-card__hero command-card__hero--blue">
        <span className="label">Current Temperature</span>
        <strong>{temperature}</strong>
      </div>

      <div className="command-card__details">
        <div className="info-tile">
          <span className="label">Safe Range</span>
          <strong>{safeRange}</strong>
        </div>
        <div className="info-tile">
          <span className="label">Node</span>
          <strong>{node}</strong>
        </div>
        <div className="info-tile info-tile--wide">
          <span className="label">Last Updated</span>
          <strong>{lastUpdated}</strong>
        </div>
      </div>

      <button type="button" className="secondary-button" onClick={onViewDetails}>
        View Freezer Details
      </button>
    </section>
  )
}
