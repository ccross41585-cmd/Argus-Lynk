import { Activity, Bell, Cloud, Cpu, Droplets, Server, Snowflake, ToggleRight, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { StatusPill } from '../components/StatusPill'
import { getLiveDevices } from '../lib/dashboardData'
import { getDeviceOnlineStatus } from '../lib/deviceOnlineStatus'
import { getDevices } from '../lib/dashboardMock'
import { isSupabaseConfigured } from '../lib/supabase'
import type { DashboardDevice, DashboardTone } from '../types/dashboard'

const TYPE_LABELS: Record<string, string> = {
  fence:       'Fence Controllers',
  well_pump:   'Well Pumps',
  freezer:     'Freezer Monitors',
  weather:     'Weather Stations',
  driveway:    'Driveway Alarms',
  relay_node:  'Relay Nodes',
  sensor_node: 'Sensor Nodes',
  custom:      'Custom Devices',
}

const DEVICE_ICONS: Record<string, React.ElementType> = {
  gateway:     Server,
  fence:       Zap,
  well_pump:   Droplets,
  freezer:     Snowflake,
  weather:     Cloud,
  driveway:    Bell,
  relay_node:  ToggleRight,
  sensor_node: Activity,
  custom:      Cpu,
}

function statusTone(status: string): DashboardTone {
  if (status === 'critical') return 'danger'
  if (status === 'warning') return 'warning'
  if (status === 'offline') return 'neutral'
  if (status === 'online') return 'success'
  return 'info'
}

function getKeyMetric(device: DashboardDevice): string {
  const m = device.metadata
  switch (device.type) {
    case 'fence':     return `Charger ${String(m.charger_power ?? '—')} · Relay ${String(m.relay_feedback ?? '—')}`
    case 'well_pump': return m.alert_state && m.alert_state !== 'Normal'
                        ? `⚠ ${String(m.alert_state)}`
                        : `Runtime ${String(m.runtime ?? '—')}`
    case 'freezer':   return `${String(m.temperature ?? '—')} · Safe ${String(m.safe_range ?? '—')}`
    case 'weather':   return `${String(m.temperature ?? '—')} · ${String(m.summary ?? '—')}`
    case 'driveway':  return `${String(m.status ?? '—')} · Last triggered ${String(m.last_triggered ?? '—')}`
    case 'gateway':   return `${String(m.nodes_online ?? 0)} nodes online · ${String(m.uplink ?? '—')}`
    default:          return '—'
  }
}

function DeviceCard({ device, onView }: { device: DashboardDevice; onView: () => void }) {
  const Icon = DEVICE_ICONS[device.type] ?? Server
  const tone = statusTone(device.status)

  return (
    <div className={`device-card device-card--${tone}`}>
      <div className="device-card__head">
        <span className="device-card__icon-wrap">
          <Icon size={18} aria-hidden="true" />
        </span>
        <div className="device-card__title-block">
          <span className="device-card__name">{device.name}</span>
          {device.location && <span className="device-card__location">{device.location}</span>}
        </div>
        <StatusPill tone={tone}>{device.status}</StatusPill>
      </div>
      <p className="device-card__metric">{getKeyMetric(device)}</p>
      <div className="device-card__actions">
        <button type="button" className="ghost-button btn-sm" onClick={onView}>
          View Details →
        </button>
      </div>
    </div>
  )
}

export function DevicesPage() {
  const navigate = useNavigate()
  const [devices, setDevices] = useState<DashboardDevice[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    document.title = 'Argus Lynk | Devices'
    const fetch = isSupabaseConfigured ? getLiveDevices() : getDevices()
    void fetch.then((data) => {
      setDevices(data.filter((d) => d.type !== 'gateway'))
      setIsLoading(false)
    })
  }, [])

  const grouped = useMemo(() => {
    const map = new Map<string, DashboardDevice[]>()
    devices
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .forEach((d) => {
        const list = map.get(d.type) ?? []
        list.push(d)
        map.set(d.type, list)
      })
    return map
  }, [devices])

  const onlineCount = devices.filter((d) => getDeviceOnlineStatus(d).online).length

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

  if (isLoading) {
    return (
      <div className="devices-page">
        <p className="eyebrow">Loading…</p>
      </div>
    )
  }

  return (
    <div className="devices-page">
      <div className="devices-page__header">
        <p className="eyebrow">Inventory</p>
        <h1 className="devices-page__title">Devices</h1>
        <p className="muted-copy">
          {devices.length} registered &nbsp;·&nbsp; {onlineCount} online
        </p>
      </div>

      {[...grouped.entries()].map(([type, list]) => (
        <section key={type} className="devices-group">
          <p className="eyebrow devices-group__label">{TYPE_LABELS[type] ?? type}</p>
          <div className="devices-grid">
            {list.map((device) => (
              <DeviceCard
                key={device.id}
                device={device}
                onView={() => void navigate(`/devices/${device.id}`)}
              />
            ))}
          </div>
        </section>
      ))}

      {devices.length === 0 && (
        <div className="panel" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <p className="eyebrow">No Devices</p>
          <p className="muted-copy">No devices have been registered for this account yet.</p>
        </div>
      )}
    </div>
  )
}
