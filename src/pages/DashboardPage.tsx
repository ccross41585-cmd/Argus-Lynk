import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { StatusPill } from '../components/StatusPill'
import { formatTimestamp, formatVoltage, humanizeToken } from '../lib/display'
import { isSupabaseConfigured, supabase } from '../lib/supabase'
import type { Device } from '../types/domain'

function upsertDevice(devices: Device[], nextDevice: Device) {
  const existingIndex = devices.findIndex((device) => device.id === nextDevice.id)

  if (existingIndex === -1) {
    return [...devices, nextDevice].sort((left, right) => left.name.localeCompare(right.name))
  }

  const nextDevices = [...devices]
  nextDevices[existingIndex] = nextDevice
  return nextDevices
}

export function DashboardPage() {
  const [devices, setDevices] = useState<Device[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) {
      setIsLoading(false)
      return
    }

    const client = supabase

    let isActive = true

    async function loadDevices() {
      setErrorMessage(null)

      const { data, error } = await client
        .from('devices')
        .select('*')
        .order('name', { ascending: true })

      if (!isActive) {
        return
      }

      if (error) {
        setErrorMessage(error.message)
        setIsLoading(false)
        return
      }

      setDevices((data ?? []) as Device[])
      setIsLoading(false)
    }

    void loadDevices()

    const channel = client
      .channel('dashboard-devices')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, (payload) => {
        if (payload.eventType === 'DELETE') {
          const deletedDevice = payload.old as Device
          setDevices((currentDevices) => currentDevices.filter((device) => device.id !== deletedDevice.id))
          return
        }

        const nextDevice = payload.new as Device
        setDevices((currentDevices) => upsertDevice(currentDevices, nextDevice))
      })
      .subscribe()

    return () => {
      isActive = false
      void client.removeChannel(channel)
    }
  }, [])

  const summary = useMemo(() => {
    const onlineCount = devices.filter((device) => device.online).length
    const fenceControllers = devices.filter((device) => device.type === 'fence_controller').length

    return {
      total: devices.length,
      online: onlineCount,
      offline: devices.length - onlineCount,
      fenceControllers,
    }
  }, [devices])

  return (
    <section className="stack">
      <header className="panel hero-card page-header">
        <p className="eyebrow">Dashboard</p>
        <h1>Device Fleet</h1>
        <p className="section-copy">
          Commands are requests. Confirmed state stays authoritative until the gateway reports back.
        </p>
      </header>

      <section className="summary-grid">
        <article className="panel summary-card">
          <p className="label">Total Devices</p>
          <div className="metric-value">{summary.total}</div>
        </article>
        <article className="panel summary-card">
          <p className="label">Online</p>
          <div className="metric-value">{summary.online}</div>
        </article>
        <article className="panel summary-card">
          <p className="label">Fence Controllers</p>
          <div className="metric-value">{summary.fenceControllers}</div>
        </article>
      </section>

      {!isSupabaseConfigured && (
        <div className="panel page-section alert alert--warning">
          Supabase is not configured yet. Add .env.local before expecting live data.
        </div>
      )}

      {errorMessage && (
        <div className="panel page-section alert alert--danger">Failed to load devices: {errorMessage}</div>
      )}

      <section className="panel page-section stack">
        <div>
          <p className="eyebrow">Field Nodes</p>
          <h2>Connected Equipment</h2>
        </div>

        {isLoading ? (
          <div className="empty-state">Loading device status from Supabase...</div>
        ) : devices.length === 0 ? (
          <div className="empty-state">No devices found. Run the schema to seed North Fence.</div>
        ) : (
          <div className="device-grid">
            {devices.map((device) => (
              <Link key={device.id} to={`/devices/${device.id}`} className="device-card">
                <div className="device-card__header">
                  <div>
                    <p className="label">{humanizeToken(device.type)}</p>
                    <h2>{device.name}</h2>
                  </div>
                  <StatusPill tone={device.online ? 'success' : 'danger'}>
                    {device.online ? 'Online' : 'Offline'}
                  </StatusPill>
                </div>

                <div className="key-value-grid">
                  <div className="key-value-item">
                    <span className="label">Confirmed State</span>
                    <strong>{humanizeToken(device.confirmed_state)}</strong>
                  </div>
                  <div className="key-value-item">
                    <span className="label">Battery</span>
                    <strong>{formatVoltage(device.battery_voltage)}</strong>
                  </div>
                  <div className="key-value-item">
                    <span className="label">Last Seen</span>
                    <strong>{formatTimestamp(device.last_seen)}</strong>
                  </div>
                  <div className="key-value-item">
                    <span className="label">Desired State</span>
                    <strong>{humanizeToken(device.desired_state)}</strong>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </section>
  )
}