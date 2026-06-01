import { useEffect, useState } from 'react'
import { getDashboardStatus, getDevices } from '../lib/dashboardMock'
import type { DashboardOverview } from '../types/dashboard'

export function HistoryPage() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    document.title = 'Argus Lynk | History'
    void Promise.all([getDashboardStatus(), getDevices()]).then(([ov]) => {
      setOverview(ov)
      setIsLoading(false)
    })
  }, [])

  const mockHistory = [
    { id: 'h1', time: '10:36 AM', device: 'Front Gate Alarm',       event: 'Motion detected at front gate',      type: 'event',   tone: 'info' },
    { id: 'h2', time: '10:22 AM', device: 'House Well Pump',         event: 'Long run alert triggered (12 min)', type: 'alert',   tone: 'warning' },
    { id: 'h3', time: '09:55 AM', device: 'North Fence Controller',  event: 'Fence turned ON by operator',        type: 'command', tone: 'success' },
    { id: 'h4', time: '09:48 AM', device: 'Farm Weather Station',    event: 'Weather data refreshed',             type: 'event',   tone: 'info' },
    { id: 'h5', time: '08:30 AM', device: 'Home Base Gateway',       event: 'Gateway connected (uplink: WiFi)',   type: 'system',  tone: 'success' },
    { id: 'h6', time: 'Yesterday', device: 'Shop Freezer',           event: 'Temperature alarm: 41°F (above range)', type: 'alert', tone: 'danger' },
    { id: 'h7', time: 'Yesterday', device: 'House Well Pump',        event: 'Pump shutoff confirmed by relay',    type: 'command', tone: 'success' },
  ]

  return (
    <div className="history-page">
      <div className="history-page__header">
        <p className="eyebrow">Audit Log</p>
        <h1 className="history-page__title">History</h1>
        <p className="muted-copy">Commands, alerts, and system events</p>
      </div>

      {isLoading && <p className="muted-copy">Loading…</p>}

      <div className="history-list">
        {mockHistory.map((item) => (
          <div key={item.id} className={`history-item history-item--${item.tone}`}>
            <div className="history-item__meta">
              <span className="history-item__time">{item.time}</span>
              <span className={`history-item__type history-item__type--${item.tone}`}>{item.type}</span>
            </div>
            <div className="history-item__body">
              <span className="history-item__device">{item.device}</span>
              <p className="history-item__event">{item.event}</p>
            </div>
          </div>
        ))}
      </div>

      {!isLoading && overview && (
        <p className="muted-copy" style={{ textAlign: 'center', marginTop: 16, fontSize: '0.78rem' }}>
          Last data sync: {new Date(overview.lastUpdated).toLocaleString()} · Full command log available in Supabase
        </p>
      )}
    </div>
  )
}
