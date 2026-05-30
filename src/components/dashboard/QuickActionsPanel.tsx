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
    <section className="stack-card" id="system">
      <div>
        <p className="eyebrow">System Health</p>
        <h2>Gateway routing state</h2>
      </div>

      <div className="stack-card__body">
        <div className="info-tile">
          <span className="label">Queue Depth</span>
          <strong>{queueDepth}</strong>
        </div>
        <div className="info-tile">
          <span className="label">Awaiting Confirmation</span>
          <strong>{awaitingConfirmations}</strong>
        </div>
        <div className="info-tile info-tile--wide">
          <span className="label">Last Command</span>
          <strong>{lastCommand}</strong>
        </div>
      </div>

      <div className="button-row button-row--stacked">
        <button type="button" className="secondary-button" onClick={onSilenceAlerts}>
          Silence Alerts
        </button>
        <button type="button" className="ghost-button" onClick={onViewSystemHealth}>
          View System Health
        </button>
      </div>
    </section>
  )
}
