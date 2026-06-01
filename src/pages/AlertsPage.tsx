import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { StatusPill } from '../components/StatusPill'
import { acknowledgeAlert, getAlerts, getDevices, silenceAlert } from '../lib/dashboardMock'
import type { AlertRecord, AlertSeverity, DashboardDevice, DashboardTone } from '../types/dashboard'

type AlertFilter = 'active' | 'acknowledged' | 'resolved' | 'all'

function severityTone(severity: AlertSeverity): DashboardTone {
  if (severity === 'critical') return 'danger'
  if (severity === 'warning') return 'warning'
  return 'info'
}

function formatTime(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso))
}

function minutesAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (diff < 1) return 'just now'
  if (diff === 1) return '1 min ago'
  if (diff < 60) return `${diff} min ago`
  const h = Math.floor(diff / 60)
  return `${h}h ago`
}

export function AlertsPage() {
  const [alerts, setAlerts] = useState<AlertRecord[]>([])
  const [devices, setDevices] = useState<DashboardDevice[]>([])
  const [filter, setFilter] = useState<AlertFilter>('active')
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    document.title = 'Argus Lynk | Alerts'
    void Promise.all([getAlerts(), getDevices()]).then(([a, d]) => {
      setAlerts(a)
      setDevices(d)
      setIsLoading(false)
    })
  }, [])

  const deviceMap = useMemo(() => {
    const map = new Map<string, string>()
    devices.forEach((d) => map.set(d.id, d.name))
    return map
  }, [devices])

  const filtered = useMemo(() => {
    return alerts.filter((a) => {
      if (filter === 'active') return !a.resolved_at && !a.acknowledged
      if (filter === 'acknowledged') return a.acknowledged && !a.resolved_at
      if (filter === 'resolved') return Boolean(a.resolved_at)
      return true
    })
  }, [alerts, filter])

  const counts = useMemo(() => ({
    active:       alerts.filter((a) => !a.resolved_at && !a.acknowledged).length,
    acknowledged: alerts.filter((a) => a.acknowledged && !a.resolved_at).length,
    resolved:     alerts.filter((a) => Boolean(a.resolved_at)).length,
  }), [alerts])

  async function handleAcknowledge(id: string) {
    await acknowledgeAlert(id)
    setAlerts((prev) => prev.map((a) => a.id === id ? { ...a, acknowledged: true } : a))
  }

  async function handleSilence(id: string) {
    await silenceAlert(id)
    setAlerts((prev) => prev.map((a) =>
      a.id === id ? { ...a, silenced_until: new Date(Date.now() + 30 * 60_000).toISOString() } : a,
    ))
  }

  const FILTERS: { key: AlertFilter; label: string; count?: number }[] = [
    { key: 'active',       label: 'Active',       count: counts.active },
    { key: 'acknowledged', label: 'Acknowledged',  count: counts.acknowledged },
    { key: 'resolved',     label: 'Resolved',      count: counts.resolved },
    { key: 'all',          label: 'All' },
  ]

  return (
    <div className="alerts-page">
      <div className="alerts-page__header">
        <p className="eyebrow">Notifications</p>
        <h1 className="alerts-page__title">Alerts</h1>
      </div>

      <div className="alerts-page__filters">
        {FILTERS.map(({ key, label, count }) => (
          <button
            key={key}
            type="button"
            className={`alerts-filter-btn${filter === key ? ' active' : ''}`}
            onClick={() => setFilter(key)}
          >
            {label}
            {count !== undefined && count > 0 && (
              <span className="alerts-filter-btn__count">{count}</span>
            )}
          </button>
        ))}
      </div>

      {isLoading && <p className="muted-copy">Loading alerts…</p>}

      {!isLoading && filtered.length === 0 && (
        <div className="panel" style={{ textAlign: 'center', padding: '32px 24px' }}>
          <p className="eyebrow">Clear</p>
          <p className="muted-copy">No {filter === 'all' ? '' : filter} alerts.</p>
        </div>
      )}

      <div className="alerts-list">
        {filtered.map((alert) => {
          const tone = severityTone(alert.severity)
          const deviceName = deviceMap.get(alert.device_id) ?? 'Unknown Device'
          const isSilenced = alert.silenced_until && new Date(alert.silenced_until) > new Date()
          return (
            <div key={alert.id} className={`alert-item alert-item--${tone}`}>
              <div className="alert-item__head">
                <StatusPill tone={tone}>{alert.severity}</StatusPill>
                <span className="alert-item__device">{deviceName}</span>
                <span className="alert-item__time">{minutesAgo(alert.created_at)}</span>
              </div>
              <p className="alert-item__message">{alert.message}</p>
              {isSilenced && (
                <p className="alert-item__note value-muted">
                  Silenced until {formatTime(alert.silenced_until!)}
                </p>
              )}
              <div className="alert-item__actions">
                {!alert.acknowledged && !alert.resolved_at && (
                  <button
                    type="button"
                    className="primary-button btn-sm"
                    onClick={() => void handleAcknowledge(alert.id)}
                  >
                    Acknowledge
                  </button>
                )}
                {!isSilenced && !alert.resolved_at && (
                  <button
                    type="button"
                    className="ghost-button btn-sm"
                    onClick={() => void handleSilence(alert.id)}
                  >
                    Silence 30m
                  </button>
                )}
                {alert.resolved_at && (
                  <span className="value-muted" style={{ fontSize: '0.8rem' }}>
                    Resolved {formatTime(alert.resolved_at)}
                  </span>
                )}
                <Link to={`/alerts/${alert.id}`} className="ghost-button btn-sm">
                  View Detail →
                </Link>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
