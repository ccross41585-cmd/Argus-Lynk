import type { AlertRecord } from '../../types/dashboard'
import { StatusPill } from '../StatusPill'

type AlertsPanelProps = {
  alerts: AlertRecord[]
  onOpenLongRunAlert: () => void
  onAcknowledge: (alertId: string) => void
}

export function AlertsPanel({ alerts, onOpenLongRunAlert, onAcknowledge }: AlertsPanelProps) {
  return (
    <section className="stack-card" id="alerts">
      <div className="command-card__header">
        <div>
          <p className="eyebrow">Active Alerts</p>
          <h2>What needs attention now</h2>
        </div>
      </div>

      <div className="alerts-panel__list">
        {alerts.map((alert) => {
          const tone = alert.severity === 'critical' ? 'danger' : alert.severity === 'warning' ? 'warning' : 'info'
          const isWellPumpAlert = alert.type === 'well_pump_long_runtime'

          return (
            <article key={alert.id} className="alerts-panel__item">
              <div className="alerts-panel__copy">
                <StatusPill tone={tone}>{alert.severity}</StatusPill>
                <strong>{alert.message}</strong>
              </div>
              <button
                type="button"
                className={isWellPumpAlert ? 'primary-button' : 'ghost-button'}
                onClick={isWellPumpAlert ? onOpenLongRunAlert : () => onAcknowledge(alert.id)}
              >
                {isWellPumpAlert ? 'Review Alert' : 'Acknowledge'}
              </button>
            </article>
          )
        })}
      </div>
    </section>
  )
}
