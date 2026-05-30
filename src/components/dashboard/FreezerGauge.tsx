import type { DashboardTone } from '../../types/dashboard'
import { StatusPill } from '../StatusPill'

type FreezerGaugeProps = {
  temperature: string
  status: string
  detail: string
  tone: DashboardTone
  onViewDetails: () => void
}

export function FreezerGauge({ temperature, status, detail, tone, onViewDetails }: FreezerGaugeProps) {
  return (
    <section className="device-panel" id="freezer">
      <div className="device-panel__header">
        <div>
          <p className="eyebrow">Freezer Monitor</p>
          <h2>Cold chain protection</h2>
        </div>
        <StatusPill tone={tone}>{status}</StatusPill>
      </div>

      <div className="freezer-gauge">
        <div className="freezer-gauge__ring">
          <span className="label">Current Temp</span>
          <strong>{temperature}</strong>
        </div>
        <p className="section-copy">{detail}</p>
      </div>

      <button type="button" className="secondary-button" onClick={onViewDetails}>
        View Details
      </button>
    </section>
  )
}