type QuickActionsPanelProps = {
  queueDepth: number
  awaitingConfirmations: number
  lastCommand: string
  onSilenceAlerts: () => void
  onViewSystemHealth: () => void
}

export function QuickActionsPanel({
  queueDepth,
  awaitingConfirmations,
  lastCommand,
  onSilenceAlerts,
  onViewSystemHealth,
}: QuickActionsPanelProps) {
  return (
    <div className="right-section" id="system">
      <p className="eyebrow">Quick Actions</p>

      <div className="data-rows">
        <div className="data-row">
          <span className="label">Queue Depth</span>
          <strong>{queueDepth}</strong>
        </div>
        <div className="data-row">
          <span className="label">Awaiting Confirmation</span>
          <strong>{awaitingConfirmations}</strong>
        </div>
        <div className="data-row data-row--full">
          <span className="label">Last Command</span>
          <span className="value-mono">{lastCommand}</span>
        </div>
      </div>

      <div className="compact-card__actions">
        <button type="button" className="secondary-button btn-sm" onClick={onSilenceAlerts}>
          Silence Alerts
        </button>
        <button type="button" className="ghost-button btn-sm" onClick={onViewSystemHealth}>
          System Health
        </button>
      </div>
    </div>
  )
}
