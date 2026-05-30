import type { CommandRecord } from '../../types/dashboard'

type LongRunAlertModalProps = {
  open: boolean
  phase: 'question' | 'extended' | 'silenced' | 'awaiting-confirmation' | 'confirmed' | 'failed'
  command: CommandRecord | null
  timeline: string[]
  onClose: () => void
  onExtend: () => void
  onShutOff: () => void
  onSilence: () => void
}

function phaseMessage(phase: LongRunAlertModalProps['phase']) {
  if (phase === 'awaiting-confirmation') {
    return 'Shutdown command sent. Waiting for field node confirmation...'
  }

  if (phase === 'confirmed') {
    return 'Pump shutdown confirmed by the field node and relay/contact feedback.'
  }

  if (phase === 'failed') {
    return 'Command sent, but shutdown confirmation was not received.'
  }

  if (phase === 'extended') {
    return 'Runtime alert extended. Continue monitoring expected water usage.'
  }

  if (phase === 'silenced') {
    return 'Alert silenced. Pump state was not changed.'
  }

  return 'Well pump has been running longer than normal. Are you using water?'
}

export function LongRunAlertModal({
  open,
  phase,
  command,
  timeline,
  onClose,
  onExtend,
  onShutOff,
  onSilence,
}: LongRunAlertModalProps) {
  if (!open) {
    return null
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-card panel" role="dialog" aria-modal="true" aria-labelledby="long-run-title">
        <div className="modal-card__header">
          <p className="eyebrow">Long-Run Alert</p>
          <h2 id="long-run-title">Well Pump Workflow</h2>
        </div>

        <p className="modal-card__message">{phaseMessage(phase)}</p>

        {command && (
          <div className="info-tile">
            <span className="label">Command Status</span>
            <strong>
              {command.command_type} · {command.status}
            </strong>
          </div>
        )}

        {timeline.length > 0 && (
          <ol className="timeline-list">
            {timeline.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}

        {phase === 'question' ? (
          <div className="button-row button-row--stacked">
            <button type="button" className="primary-button" onClick={onExtend}>
              Yes, I&apos;m using water
            </button>
            <button type="button" className="danger-button" onClick={onShutOff}>
              No, shut pump off
            </button>
            <button type="button" className="secondary-button" onClick={onSilence}>
              Silence alert
            </button>
          </div>
        ) : (
          <button type="button" className="primary-button" onClick={onClose}>
            Close
          </button>
        )}
      </section>
    </div>
  )
}