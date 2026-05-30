type QuickActionsProps = {
  onSilenceAlerts: () => void
  onRestartWellPump: () => void
  onTestFence: () => void
  onSystemHealth: () => void
}

export function QuickActions({
  onSilenceAlerts,
  onRestartWellPump,
  onTestFence,
  onSystemHealth,
}: QuickActionsProps) {
  return (
    <section className="device-panel quick-actions-panel">
      <div className="device-panel__header">
        <div>
          <p className="eyebrow">Quick Actions</p>
          <h2>Rapid operator controls</h2>
        </div>
      </div>

      <div className="quick-actions-grid">
        <button type="button" className="secondary-button" onClick={onSilenceAlerts}>
          Silence Alerts
        </button>
        <button type="button" className="primary-button" onClick={onRestartWellPump}>
          Restart Well Pump
        </button>
        <button type="button" className="secondary-button" onClick={onTestFence}>
          Test Fence
        </button>
        <button type="button" className="ghost-button" onClick={onSystemHealth}>
          System Health
        </button>
      </div>
    </section>
  )
}