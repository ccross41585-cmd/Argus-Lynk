import { useRef, useState } from 'react'
import type { AlertRecord } from '../../types/dashboard'
import { StatusPill } from '../StatusPill'

type AlertsPanelProps = {
  alerts: AlertRecord[]
  onOpenLongRunAlert: () => void
  onAcknowledge: (alertId: string) => void
  onClearAll: () => void
}

function SwipeableAlertRow({
  alert,
  onOpenLongRunAlert,
  onAcknowledge,
}: {
  alert: AlertRecord
  onOpenLongRunAlert: () => void
  onAcknowledge: (id: string) => void
}) {
  const tone = alert.severity === 'critical' ? 'danger' : alert.severity === 'warning' ? 'warning' : 'info'
  const isWellPumpAlert = alert.type === 'well_pump_long_runtime'
  const [dismissed, setDismissed] = useState(false)
  const [translateX, setTranslateX] = useState(0)
  const touchStartX = useRef<number | null>(null)

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (touchStartX.current === null) return
    const delta = e.touches[0].clientX - touchStartX.current
    if (delta < 0) setTranslateX(delta) // only allow leftward swipe
  }

  function handleTouchEnd() {
    if (translateX < -80) {
      setDismissed(true)
      onAcknowledge(alert.id)
    } else {
      setTranslateX(0)
    }
    touchStartX.current = null
  }

  if (dismissed) return null

  return (
    <div
      className="alert-row-flat"
      style={{
        transform: `translateX(${translateX}px)`,
        transition: translateX === 0 ? 'transform 0.25s ease' : 'none',
        opacity: Math.max(0.3, 1 + translateX / 160),
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div className="alert-row-flat__copy">
        <StatusPill tone={tone}>{alert.severity}</StatusPill>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span>{alert.message}</span>
          {alert.created_at && (
            <span style={{ fontSize: '0.72rem', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
              {new Date(alert.created_at).toLocaleString(undefined, {
                month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit',
              })}
            </span>
          )}
        </div>
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
}

export function AlertsPanel({ alerts, onOpenLongRunAlert, onAcknowledge, onClearAll }: AlertsPanelProps) {
  return (
    <div className="right-section" id="alerts">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <p className="eyebrow" style={{ margin: 0 }}>Active Alerts</p>
        {alerts.length > 0 && (
          <button
            type="button"
            className="ghost-button btn-sm"
            onClick={onClearAll}
            style={{ fontSize: '0.72rem', padding: '2px 8px' }}
          >
            Clear All
          </button>
        )}
      </div>

      {alerts.length === 0 ? (
        <p className="muted-copy empty-state">No active alerts.</p>
      ) : (
        <>
          <p className="muted-copy" style={{ fontSize: '0.75rem', marginBottom: 6 }}>Swipe left to dismiss</p>
          <div className="alert-rows">
            {alerts.map((alert) => (
              <SwipeableAlertRow
                key={alert.id}
                alert={alert}
                onOpenLongRunAlert={onOpenLongRunAlert}
                onAcknowledge={onAcknowledge}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

