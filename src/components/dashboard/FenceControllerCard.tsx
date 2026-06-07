import type { CommandRecord } from '../../types/dashboard'
import { StatusPill } from '../StatusPill'

type FenceControllerCardProps = {
  chargerPower: 'ON' | 'OFF'
  fieldNode: 'Online' | 'Offline'
  lastCommand: 'ON' | 'OFF' | 'TEST'
  feedback: string
  note: string
  auxRaw?: string
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
  auxRaw,
  latestCommand,
  onTurnOn,
  onTurnOff,
  onTestRelay,
}: FenceControllerCardProps) {
  return (
    <section className="compact-card" id="fence-line">
      <div className="compact-card__header">
        <p className="eyebrow">Fence Controller</p>
        <StatusPill tone={chargerPower === 'ON' ? 'success' : 'neutral'}>{chargerPower}</StatusPill>
      </div>

      <div className="data-rows">
        <div className="data-row">
          <span className="label">Charger Power</span>
          <strong className={chargerPower === 'ON' ? 'value-green' : 'value-muted'}>{chargerPower}</strong>
        </div>
        <div className="data-row">
          <span className="label">Field Node</span>
          <strong className={fieldNode === 'Online' ? 'value-green' : 'value-danger'}>{fieldNode}</strong>
        </div>
        <div className="data-row">
          <span className="label">Last Command</span>
          <strong>{lastCommand}</strong>
        </div>
        <div className="data-row">
          <span className="label">Contactor Feedback</span>
          <strong
            className={
              feedback.includes('confirmed ON') ? 'value-green'
              : feedback.includes('confirmed OFF') ? 'value-muted'
              : 'value-danger'
            }
          >{feedback}</strong>
        </div>
        <div className="data-row">
          <span className="label">Aux Raw (GPIO34)</span>
          {auxRaw ? (
            <strong
              className={
                auxRaw === 'AUX_LOW' ? 'value-green'
                : auxRaw === 'AUX_HIGH' ? 'value-muted'
                : 'value-muted'
              }
            >{auxRaw}</strong>
          ) : (
            <strong className="value-danger">Not received</strong>
          )}
        </div>
      </div>

      <p className="inline-note">{note}</p>

      {latestCommand && latestCommand.target_device_id === 'fence-line-1' && (
        <div className="alert alert--neutral">
          {latestCommand.command_type} — {latestCommand.status}
        </div>
      )}

      <div className="compact-card__actions">
        <button type="button" className="primary-button" onClick={onTurnOn}>On</button>
        <button type="button" className="secondary-button" onClick={onTurnOff}>Off</button>
        <button type="button" className="ghost-button" onClick={onTestRelay}>Test</button>
      </div>
    </section>
  )
}
