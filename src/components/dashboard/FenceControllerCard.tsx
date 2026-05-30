import type { CommandRecord } from '../../types/dashboard'
import { StatusPill } from '../StatusPill'

type FenceControllerCardProps = {
  chargerPower: 'ON' | 'OFF'
  fieldNode: 'Online' | 'Offline'
  lastCommand: 'ON' | 'OFF' | 'TEST'
  feedback: string
  note: string
  latestCommand: CommandRecord | null
  onTurnOn: () => void
  onTurnOff: () => void
  onTestRelay: () => void
}

export function FenceControllerCard({
  chargerPower,
  fieldNode,
  lastCommand,
  feedback,
  note,
  latestCommand,
  onTurnOn,
  onTurnOff,
  onTestRelay,
}: FenceControllerCardProps) {
  return (
    <section className="command-card command-card--fence" id="fence-line">
      <div className="command-card__header">
        <div>
          <p className="eyebrow">Fence Controller</p>
          <h2>Charger control and contactor feedback</h2>
        </div>
        <StatusPill tone={chargerPower === 'ON' ? 'success' : 'neutral'}>{chargerPower}</StatusPill>
      </div>

      <div className="command-card__hero">
        <span className="label">Charger Power</span>
        <strong>{chargerPower}</strong>
      </div>

      <div className="command-card__details">
        <div className="info-tile">
          <span className="label">Field Node</span>
          <strong>{fieldNode}</strong>
        </div>
        <div className="info-tile">
          <span className="label">Last Command</span>
          <strong>{lastCommand}</strong>
        </div>
        <div className="info-tile info-tile--wide">
          <span className="label">Feedback</span>
          <strong>{feedback}</strong>
        </div>
      </div>

      <p className="command-card__note">{note}</p>

      {latestCommand && latestCommand.target_device_id === 'fence-line-1' && (
        <div className="alert alert--neutral">
          Last fence command: {latestCommand.command_type} is {latestCommand.status}.
        </div>
      )}

      <div className="button-row button-row--triple">
        <button type="button" className="primary-button" onClick={onTurnOn}>
          Turn Fence On
        </button>
        <button type="button" className="secondary-button" onClick={onTurnOff}>
          Turn Fence Off
        </button>
        <button type="button" className="ghost-button" onClick={onTestRelay}>
          Test Relay
        </button>
      </div>
    </section>
  )
}
