import type { CommandRecord, DashboardTone } from '../../types/dashboard'
import { StatusPill } from '../StatusPill'

type WellPumpPanelProps = {
  status: string
  runtime: string
  pressure: string
  usage: string
  tone: DashboardTone
  latestCommand: CommandRecord | null
  onViewDetails: () => void
  onReviewAlert: () => void
}

export function WellPumpPanel({
  status,
  runtime,
  pressure,
  usage,
  tone,
  latestCommand,
  onViewDetails,
  onReviewAlert,
}: WellPumpPanelProps) {
  return (
    <section className="device-panel" id="well-pump">
      <div className="device-panel__header">
        <div>
          <p className="eyebrow">Well Pump Monitor</p>
          <h2>Pressure and runtime control</h2>
        </div>
        <StatusPill tone={tone}>{status}</StatusPill>
      </div>

      <div className="well-pump-layout">
        <div className="well-pump-metric">
          <span className="label">Current runtime</span>
          <strong>{runtime}</strong>
        </div>
        <div className="well-pump-metric">
          <span className="label">Pressure</span>
          <strong>{pressure}</strong>
        </div>
        <div className="well-pump-metric">
          <span className="label">Estimated usage today</span>
          <strong>{usage}</strong>
        </div>
      </div>

      {latestCommand && (
        <div className="alert alert--neutral">
          Latest command: {latestCommand.command_type} is {latestCommand.status}.
        </div>
      )}

      <div className="button-row button-row--stacked">
        <button type="button" className="primary-button" onClick={onReviewAlert}>
          Review Long-Run Alert
        </button>
        <button type="button" className="secondary-button" onClick={onViewDetails}>
          View Details
        </button>
      </div>
    </section>
  )
}