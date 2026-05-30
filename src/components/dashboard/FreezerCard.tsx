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
    <section className="compact-card" id="freezer">
      <div className="compact-card__header">
        <p className="eyebrow">Freezer</p>
        <StatusPill tone={tone}>{alertState}</StatusPill>
      </div>

      <div className="compact-card__hero-temp">
        <strong className="hero-value hero-value--blue">{temperature}</strong>
        <span className="label">Safe range: {safeRange}</span>
      </div>

      <div className="data-rows">
        <div className="data-row">
          <span className="label">Node</span>
          <strong className={node === 'Online' ? 'value-green' : 'value-danger'}>{node}</strong>
        </div>
        <div className="data-row">
          <span className="label">Last Update</span>
          <strong>{lastUpdated}</strong>
        </div>
      </div>

      <button type="button" className="ghost-button ghost-button--sm" onClick={onViewDetails}>
        View Details
      </button>
    </section>
  )
}
