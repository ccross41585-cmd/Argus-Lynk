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
  return (
    <section className="command-card command-card--pump" id="well-pump">
      <div className="command-card__header">
        <div>
          <p className="eyebrow">Well Pump</p>
          <h2>Simple contactor status and runtime</h2>
        </div>
        <StatusPill tone={alertState === 'Long Run Alert' ? 'warning' : 'info'}>{alertState}</StatusPill>
      </div>

      <div className="command-card__hero command-card__hero--blue">
        <span className="label">Pump Power</span>
        <strong>{pumpPower}</strong>
        <p className="muted-copy">Runtime {runtime}</p>
      </div>

      <div className="command-card__details">
        <div className="info-tile">
          <span className="label">Field Node</span>
          <strong>{fieldNode}</strong>
        </div>
        <div className="info-tile">
          <span className="label">Runtime</span>
          <strong>{runtime}</strong>
        </div>
        <div className="info-tile">
          <span className="label">Alert</span>
          <strong>{alertState}</strong>
        </div>
        <div className="info-tile info-tile--wide">
          <span className="label">Feedback</span>
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
            : `Latest command: ${latestCommand.command_type} is ${latestCommand.status}.`}
        </div>
      )}

      <div className="button-row button-row--triple">
        <button type="button" className="danger-button" onClick={onShutOff}>
          Shut Off Pump
        </button>
        <button type="button" className="primary-button" onClick={onRestart}>
          Restart Pump
        </button>
        <button type="button" className="secondary-button" onClick={onViewDetails}>
          View Details
        </button>
      </div>
    </section>
  )
}
