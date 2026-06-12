import { StatusPill } from '../StatusPill'

type FreezerCardProps = {
  temperature: string
  safeRange: string
  node: 'Online' | 'Offline'
  lastUpdated: string
  alertState: 'Normal' | 'Warning' | 'Critical'
  alarmThreshold?: string
  batteryLabel?: string
  trendPoints?: number[]
  onViewDetails: () => void
}

export function FreezerCard({
  temperature,
  safeRange,
  node,
  lastUpdated,
  alertState,
  alarmThreshold,
  batteryLabel,
  trendPoints,
  onViewDetails,
}: FreezerCardProps) {
  const tone = alertState === 'Critical' ? 'danger' : alertState === 'Warning' ? 'warning' : 'info'
  const trend = (trendPoints ?? []).slice(-24)

  const path = (() => {
    if (trend.length < 2) return ''
    const min = Math.min(...trend)
    const max = Math.max(...trend)
    const span = Math.max(max - min, 0.0001)
    const width = 120
    const height = 28
    const step = width / (trend.length - 1)
    return trend.map((p, i) => {
      const x = i * step
      const y = height - ((p - min) / span) * (height - 2) - 1
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
    }).join(' ')
  })()

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
        {alarmThreshold && (
          <div className="data-row">
            <span className="label">Alarm Threshold</span>
            <strong>{alarmThreshold}</strong>
          </div>
        )}
        {batteryLabel && (
          <div className="data-row">
            <span className="label">Battery</span>
            <strong>{batteryLabel}</strong>
          </div>
        )}
        <div className="data-row">
          <span className="label">Last Update</span>
          <strong>{lastUpdated}</strong>
        </div>
      </div>

      {path && (
        <div className="freezer-mini-trend" aria-hidden="true">
          <svg viewBox="0 0 120 28" preserveAspectRatio="none">
            <path d={path} />
          </svg>
        </div>
      )}

      <button type="button" className="ghost-button ghost-button--sm" onClick={onViewDetails}>
        View Details
      </button>
    </section>
  )
}
