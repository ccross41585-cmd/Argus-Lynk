import { useEffect, useState } from 'react'
import { StatusPill } from '../components/StatusPill'
import { getDeviceOnlineStatus } from '../lib/deviceOnlineStatus'
import { getDashboardStatus, getDevices } from '../lib/dashboardMock'
import type { DashboardDevice, DashboardOverview, DashboardTone } from '../types/dashboard'

function statusTone(online: boolean): DashboardTone {
  return online ? 'success' : 'neutral'
}

function formatLastSeen(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

export function SystemPage() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null)
  const [devices, setDevices] = useState<DashboardDevice[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    document.title = 'Argus Lynk | System'
    void Promise.all([getDashboardStatus(), getDevices()]).then(([ov, dv]) => {
      setOverview(ov)
      setDevices(dv)
      setIsLoading(false)
    })
  }, [])

  useEffect(() => {
    for (const device of devices) {
      if (device.type !== 'fence') continue
      console.log('[ONLINE STATUS]', device.name, {
        onlineField: device.online,
        last_seen: device.last_seen,
        last_heartbeat: device.last_heartbeat,
        updated_at: device.updated_at,
        computed: getDeviceOnlineStatus(device),
      })
    }
  }, [devices])

  if (isLoading || !overview) {
    return (
      <div className="system-page">
        <p className="eyebrow">Loading…</p>
      </div>
    )
  }

  const gateway = devices.find((d) => d.type === 'gateway')
  const fieldNodes = devices.filter((d) => d.type !== 'gateway')
  const onlineCount = fieldNodes.filter((d) => getDeviceOnlineStatus(d).online).length

  return (
    <div className="system-page">
      <div className="system-page__header">
        <p className="eyebrow">Infrastructure</p>
        <h1 className="system-page__title">System Health</h1>
      </div>

      {/* Gateway status */}
      <section className="compact-card system-gateway">
        <div className="compact-card__header">
          <div>
            <p className="eyebrow">Gateway</p>
            <h2>{gateway?.name ?? 'Home Base Gateway'}</h2>
            {gateway?.location && <p className="muted-copy">{gateway.location}</p>}
          </div>
          <StatusPill tone={overview.gatewayStatus === 'online' ? 'success' : 'danger'}>
            {overview.gatewayStatus}
          </StatusPill>
        </div>
        <div className="data-rows">
          <div className="data-row">
            <span className="label">Network Strength</span>
            <strong className={overview.networkStrength === 'Strong' ? 'value-green' : 'value-danger'}>
              {overview.networkStrength}
            </strong>
          </div>
          <div className="data-row">
            <span className="label">System Health</span>
            <strong>{overview.systemHealth}</strong>
          </div>
          <div className="data-row">
            <span className="label">Uplink</span>
            <strong>{String(gateway?.metadata.uplink ?? 'WiFi')}</strong>
          </div>
          <div className="data-row">
            <span className="label">Firmware</span>
            <strong className="value-mono">{String(gateway?.metadata.firmware ?? '—')}</strong>
          </div>
        </div>
      </section>

      {/* Command queue */}
      <section className="compact-card">
        <p className="eyebrow">Command Queue</p>
        <div className="data-rows">
          <div className="data-row">
            <span className="label">Queue Depth</span>
            <strong>{overview.system.queueDepth}</strong>
          </div>
          <div className="data-row">
            <span className="label">Awaiting Confirmation</span>
            <strong>{overview.system.awaitingConfirmations}</strong>
          </div>
          <div className="data-row data-row--full">
            <span className="label">Last Command</span>
            <span className="value-mono">{overview.system.lastCommand}</span>
          </div>
        </div>
      </section>

      {/* Nodes table */}
      <section className="compact-card">
        <div className="compact-card__header">
          <p className="eyebrow">Field Nodes</p>
          <StatusPill tone={onlineCount === fieldNodes.length ? 'success' : 'warning'}>
            {onlineCount}/{fieldNodes.length} online
          </StatusPill>
        </div>
        <div className="nodes-table">
          <div className="nodes-table__head">
            <span>Name</span>
            <span>Type</span>
            <span>Status</span>
            <span>Last Seen</span>
          </div>
          {fieldNodes.map((node) => (
            <div key={node.id} className="nodes-table__row">
              <span>{node.name}</span>
              <span className="value-mono">{node.type}</span>
              <StatusPill tone={statusTone(getDeviceOnlineStatus(node).online)}>{getDeviceOnlineStatus(node).label}</StatusPill>
              <span className="value-muted">{formatLastSeen(node.last_seen)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
