import type { AlertRecord } from '../../types/dashboard'
import { StatusPill } from '../StatusPill'

type AlertsPanelProps = {
  alerts: AlertRecord[]
  onOpenLongRunAlert: () => void
  onAcknowledge: (alertId: string) => void
}

export function AlertsPanel({ alerts, onOpenLongRunAlert, onAcknowledge }: AlertsPanelProps) {
  return (
    <div className="right-section" id="alerts">
      <p className="eyebrow">Active Alerts</p>

      {alerts.length === 0 ? (
        <p className="muted-copy empty-state">No active alerts.</p>
      ) : (
        <div className="alert-rows">
          {alerts.map((alert) => {
            const tone = alert.severity === 'critical' ? 'danger' : alert.severity === 'warning' ? 'warning' : 'info'
            const isWellPumpAlert = alert.type === 'well_pump_long_runtime'

            return (
              <div key={alert.id} className="alert-row-flat">
                <div className="alert-row-flat__copy">
                  <StatusPill tone={tone}>{alert.severity}</StatusPill>
                  <span>{alert.message}</span>
                </div>
                <button
                  type="button"
                  className={isWellPumpAlert ? 'primary-button btn-sm' : 'ghost-button btn-sm'}
                  onClick={isWellPumpAlert ? onOpenLongRunAlert : () => onAcknowledge(alert.id)}
                >
                  {isWellPumpAlert ? 'Review' : 'Ack'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
