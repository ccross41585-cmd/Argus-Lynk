import { Wifi, WifiOff, SlidersHorizontal, Radio } from 'lucide-react'
import { HoldToConfirm } from '../HoldToConfirm'

type FieldLynkControlSheetProps = {
  open: boolean
  deviceName: string
  currentState: string
  connectionStatus: string
  auxFeedback: string
  lastUpdate: string
  signalStrength?: string
  commandProgress: string
  sending: boolean
  onClose: () => void
  onOpenSettings: () => void
  onHoldTurnOn: () => void | Promise<void>
  onHoldTurnOff: () => void | Promise<void>
}

export function FieldLynkControlSheet({
  open,
  deviceName,
  currentState,
  connectionStatus,
  auxFeedback,
  lastUpdate,
  signalStrength,
  commandProgress,
  sending,
  onClose,
  onOpenSettings,
  onHoldTurnOn,
  onHoldTurnOff,
}: FieldLynkControlSheetProps) {
  if (!open) return null

  const isOn = currentState.toUpperCase().includes('SECURE') ||
    currentState.toUpperCase().includes('ON')

  const connectionToneClass = connectionStatus === 'ONLINE'
    ? 'value-green'
    : connectionStatus === 'OFFLINE'
      ? 'value-danger'
      : ''

  return (
    <div className="modal-backdrop modal-backdrop--sheet" role="presentation" onClick={onClose}>
      <section
        className="field-lynk-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="field-lynk-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="field-lynk-sheet__handle" />
        <div className="field-lynk-sheet__header">
          <div>
            <p className="eyebrow">Fence Controller</p>
            <h2 id="field-lynk-sheet-title">{deviceName}</h2>
          </div>
          <button type="button" className="ghost-button btn-sm" onClick={onOpenSettings}>
            <SlidersHorizontal size={16} />
            Settings
          </button>
        </div>

        <div className="field-lynk-sheet__grid">
          <div className="data-row"><span className="label">Current State</span><strong>{currentState}</strong></div>
          <div className="data-row">
            <span className="label">Connection</span>
            <strong className={connectionToneClass}>
              {connectionStatus === 'ONLINE' ? <Wifi size={14} /> : <WifiOff size={14} />} {connectionStatus}
            </strong>
          </div>
          <div className="data-row"><span className="label">Aux Feedback</span><strong>{auxFeedback}</strong></div>
          <div className="data-row"><span className="label">Last Update</span><strong>{lastUpdate}</strong></div>
          <div className="data-row"><span className="label">Signal</span><strong><Radio size={14} /> {signalStrength ?? 'n/a'}</strong></div>
        </div>

        <HoldToConfirm
          className="field-lynk-sheet__hold"
          label={isOn ? 'HOLD TO TURN OFF' : 'HOLD TO TURN ON'}
          subLabel="Press and hold for 1.5s"
          holdMs={1500}
          loading={sending}
          onConfirm={isOn ? onHoldTurnOff : onHoldTurnOn}
        />

        <p className="inline-note">Phone vibrates + chime when sent</p>

        <div className="alert alert--neutral field-lynk-sheet__progress">{commandProgress}</div>

        <button type="button" className="secondary-button" onClick={onClose}>Close</button>
      </section>
    </div>
  )
}
