type QuickActionsPanelProps = {
  queueDepth: number
  awaitingConfirmations: number
  lastCommand: string
  browserConnection: string
  networkHint?: string
  lastSuccessfulCommand?: string
  gatewayLastSeen?: string
  fieldNodeLastSeen?: string
  onSilenceAlerts: () => void
  onViewSystemHealth: () => void
}

export function QuickActionsPanel({
  queueDepth,
  awaitingConfirmations,
  lastCommand,
  browserConnection,
  networkHint,
  lastSuccessfulCommand,
  gatewayLastSeen,
  fieldNodeLastSeen,
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
        <div className="data-row">
          <span className="label">Phone Link</span>
          <strong>{browserConnection}</strong>
        </div>
        <div className="data-row">
          <span className="label">Gateway Last Seen</span>
          <strong>{gatewayLastSeen ?? '—'}</strong>
        </div>
        <div className="data-row">
          <span className="label">Field Lynk Last Seen</span>
          <strong>{fieldNodeLastSeen ?? '—'}</strong>
        </div>
        <div className="data-row data-row--full">
          <span className="label">Last Successful Cmd</span>
          <span className="value-mono">{lastSuccessfulCommand ?? '—'}</span>
        </div>
        {networkHint && (
          <div className="data-row data-row--full">
            <span className="label">Network Hint</span>
            <span className="value-mono">{networkHint}</span>
          </div>
        )}
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
