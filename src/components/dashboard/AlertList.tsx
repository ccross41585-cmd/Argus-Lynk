import type { AlertRecord } from '../../types/dashboard'
import { StatusPill } from '../StatusPill'

type AlertListProps = {
  alerts: AlertRecord[]
  onViewAll: () => void
  onOpenLongRunAlert: () => void
  onAcknowledge: (alertId: string) => void
}

function toneForSeverity(severity: AlertRecord['severity']) {
  if (severity === 'critical') {
    return 'danger' as const
  }

  if (severity === 'warning') {
    return 'warning' as const
  }

  return 'info' as const
}

function formatAlertTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value))
}

export function AlertList({ alerts, onViewAll, onOpenLongRunAlert, onAcknowledge }: AlertListProps) {
  return (
    <section className="device-panel" id="alerts">
      <div className="device-panel__header">
        <div>
          <p className="eyebrow">Active Alerts</p>
          <h2>Operator attention needed</h2>
        </div>
        <button type="button" className="secondary-button" onClick={onViewAll}>
          View All Alerts
        </button>
      </div>

      <div className="alert-list">
        {alerts.map((alert) => {
          const isWellPumpLongRun = alert.type === 'well_pump_long_runtime'

          return (
            <article key={alert.id} className="alert-row">
              <div className="alert-row__copy">
                <div className="alert-row__meta">
                  <StatusPill tone={toneForSeverity(alert.severity)}>{alert.severity}</StatusPill>
                  <span className="label">{formatAlertTime(alert.created_at)}</span>
                </div>
                <strong>{alert.message}</strong>
                <p className="muted-copy">{isWellPumpLongRun ? 'Well pump monitor' : 'Driveway monitor'}</p>
              </div>
              <div className="alert-row__actions">
                {isWellPumpLongRun ? (
                  <button type="button" className="primary-button" onClick={onOpenLongRunAlert}>
                    Review Alert
                  </button>
                ) : (
                  <button type="button" className="ghost-button" onClick={() => onAcknowledge(alert.id)}>
                    Acknowledge
                  </button>
                )}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}