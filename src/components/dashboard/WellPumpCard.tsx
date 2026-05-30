import type { CommandRecord } from '../../types/dashboard'
import { StatusPill } from '../StatusPill'

type WellPumpCardProps = {
  pumpPower: 'ON' | 'OFF'
  runtime: string
  fieldNode: 'Online' | 'Offline'
  feedback: string
  alertState: 'Normal' | 'Long Run Alert'
  latestCommand: CommandRecord | null
  onShutOff: () => void
  onRestart: () => void
  onViewDetails: () => void
}

export function WellPumpCard({
  pumpPower,
  runtime,
  fieldNode,
  feedback,
  alertState,
  latestCommand,
  onShutOff,
  onRestart,
  onViewDetails,
}: WellPumpCardProps) {
  const isRunning = pumpPower === 'ON'
  const hasAlert = alertState === 'Long Run Alert'

  return (
    <section className="panel-card" id="well-pump">
      <div className="panel-card__header">
        <div>
          <p className="eyebrow">Well Pump</p>
          <h2 className="panel-card__title">Contactor status &amp; runtime</h2>
        </div>
        <StatusPill tone={hasAlert ? 'warning' : 'info'}>{alertState}</StatusPill>
      </div>

      <div className="panel-card__hero">
        <div>
          <span className="label">Pump Power</span>
          <strong className={`hero-value hero-value--${isRunning ? 'blue' : 'muted'}`}>{pumpPower}</strong>
        </div>
        <div>
          <span className="label">Runtime</span>
          <strong className="hero-sub">{runtime}</strong>
        </div>
      </div>

      <div className="data-rows">
        <div className="data-row">
          <span className="label">Field Node</span>
          <strong className={fieldNode === 'Online' ? 'value-green' : 'value-danger'}>{fieldNode}</strong>
        </div>
        <div className="data-row">
          <span className="label">Contactor Feedback</span>
          <strong>{feedback}</strong>
        </div>
      </div>

      {latestCommand && latestCommand.target_device_id === 'well-pump-1' && (
        <div
          className={`alert ${
            latestCommand.status === 'failed'
              ? 'alert--danger'
              : latestCommand.status === 'confirmed'
                ? 'alert--success'
                : 'alert--warning'
          }`}
        >
          {latestCommand.command_type === 'WELL_PUMP_SHUTOFF' && latestCommand.status !== 'confirmed'
            ? 'Shutdown command sent. Waiting for field node confirmation...'
            : `Latest command: ${latestCommand.command_type} — ${latestCommand.status}`}
        </div>
      )}

      <div className="panel-card__actions">
        <button type="button" className="danger-button" onClick={onShutOff}>
          Shut Off
        </button>
        <button type="button" className="primary-button" onClick={onRestart}>
          Restart
        </button>
        <button type="button" className="ghost-button" onClick={onViewDetails}>
          Details
        </button>
      </div>
    </section>
  )
}
