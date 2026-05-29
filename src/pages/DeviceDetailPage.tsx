import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { StatusPill } from '../components/StatusPill'
import {
  formatTimestamp,
  formatVoltage,
  humanizeToken,
  isPendingStatus,
} from '../lib/display'
import { isSupabaseConfigured, supabase } from '../lib/supabase'
import type { Device, DeviceCommand, DeviceEvent } from '../types/domain'

export function DeviceDetailPage() {
  const { deviceId } = useParams<{ deviceId: string }>()
  const [device, setDevice] = useState<Device | null>(null)
  const [latestCommand, setLatestCommand] = useState<DeviceCommand | null>(null)
  const [events, setEvents] = useState<DeviceEvent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)

  useEffect(() => {
    if (!deviceId || !supabase) {
      setIsLoading(false)
      return
    }

    const client = supabase

    let isActive = true

    async function loadDeviceState() {
      setActionError(null)

      const [deviceResponse, commandResponse, eventResponse] = await Promise.all([
        client.from('devices').select('*').eq('id', deviceId).single(),
        client
          .from('device_commands')
          .select('*')
          .eq('device_id', deviceId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        client
          .from('device_events')
          .select('*')
          .eq('device_id', deviceId)
          .order('created_at', { ascending: false })
          .limit(8),
      ])

      if (!isActive) {
        return
      }

      if (deviceResponse.error) {
        setActionError(deviceResponse.error.message)
        setIsLoading(false)
        return
      }

      if (commandResponse.error) {
        setActionError(commandResponse.error.message)
      }

      if (eventResponse.error) {
        setActionError(eventResponse.error.message)
      }

      setDevice(deviceResponse.data as Device)
      setLatestCommand((commandResponse.data ?? null) as DeviceCommand | null)
      setEvents((eventResponse.data ?? []) as DeviceEvent[])
      setIsLoading(false)
    }

    void loadDeviceState()

    const channel = client
      .channel(`device-${deviceId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'devices', filter: `id=eq.${deviceId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            setDevice(null)
            return
          }

          setDevice(payload.new as Device)
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'device_commands',
          filter: `device_id=eq.${deviceId}`,
        },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            return
          }

          const nextCommand = payload.new as DeviceCommand
          setLatestCommand((currentCommand) => {
            if (!currentCommand) {
              return nextCommand
            }

            return new Date(nextCommand.created_at) >= new Date(currentCommand.created_at)
              ? nextCommand
              : currentCommand
          })
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'device_events',
          filter: `device_id=eq.${deviceId}`,
        },
        (payload) => {
          setEvents((currentEvents) => [payload.new as DeviceEvent, ...currentEvents].slice(0, 8))
        },
      )
      .subscribe()

    return () => {
      isActive = false
      void client.removeChannel(channel)
    }
  }, [deviceId])

  async function sendCommand(command: 'turn_on' | 'turn_off') {
    if (!supabase || !device) {
      return
    }

    const wantsToProceed = window.confirm(
      `Send ${command === 'turn_on' ? 'TURN ON' : 'TURN OFF'} to ${device.name}?`,
    )

    if (!wantsToProceed) {
      return
    }

    setIsSending(true)
    setActionError(null)
    setActionMessage(null)

    const { data, error } = await supabase
      .from('device_commands')
      .insert({
        device_id: device.id,
        command,
        status: 'pending',
        gateway_id: device.gateway_id,
      })
      .select('*')
      .single()

    setIsSending(false)

    if (error) {
      setActionError(error.message)
      return
    }

    setLatestCommand(data as DeviceCommand)
    setActionMessage('Command queued. Waiting for confirmation from the gateway...')
  }

  if (!isSupabaseConfigured) {
    return (
      <section className="panel page-section alert alert--warning">
        Supabase environment values are missing. Configure .env.local before testing device control.
      </section>
    )
  }

  if (!deviceId) {
    return (
      <section className="panel page-section alert alert--danger">
        No device id was provided in the route.
      </section>
    )
  }

  if (isLoading) {
    return (
      <section className="panel page-section empty-state">Loading device state and command history...</section>
    )
  }

  if (!device) {
    return (
      <section className="panel page-section stack">
        <Link to="/dashboard" className="back-link">
          Back to Dashboard
        </Link>
        <div className="alert alert--danger">This device could not be found.</div>
      </section>
    )
  }

  const latestCommandStatus = latestCommand?.status ?? null
  const waitingForConfirmation = isPendingStatus(latestCommandStatus)

  return (
    <section className="stack">
      <header className="panel page-section detail-header">
        <Link to="/dashboard" className="back-link">
          Back to Dashboard
        </Link>
        <p className="eyebrow">Device Detail</p>
        <h1>{device.name}</h1>
        <p className="section-copy">
          Confirmed state is the physical truth. Desired state only reflects the most recent request.
        </p>
      </header>

      <section className="detail-grid">
        <article className="panel detail-card stack">
          <div className="device-card__header">
            <div>
              <p className="label">{humanizeToken(device.type)}</p>
              <h2>Current Device Snapshot</h2>
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
              <span className="label">Desired State</span>
              <strong>{humanizeToken(device.desired_state)}</strong>
            </div>
            <div className="key-value-item">
              <span className="label">Last Seen</span>
              <strong>{formatTimestamp(device.last_seen)}</strong>
            </div>
            <div className="key-value-item">
              <span className="label">Battery</span>
              <strong>{formatVoltage(device.battery_voltage)}</strong>
            </div>
            <div className="key-value-item">
              <span className="label">Gateway</span>
              <strong>{device.gateway_id ?? 'Unassigned'}</strong>
            </div>
            <div className="key-value-item">
              <span className="label">RSSI</span>
              <strong>{device.rssi ?? 'n/a'}</strong>
            </div>
          </div>

          <div className="alert-stack">
            {waitingForConfirmation && latestCommand && (
              <div className="alert alert--warning">
                Waiting for confirmation... Latest command {latestCommand.command} is still {latestCommand.status}.
              </div>
            )}

            {!waitingForConfirmation && latestCommand?.status === 'acknowledged' && (
              <div className="alert alert--success">
                Latest command acknowledged at {formatTimestamp(latestCommand.acknowledged_at)}.
              </div>
            )}

            {(latestCommand?.status === 'failed' || latestCommand?.status === 'expired') && (
              <div className="alert alert--danger">
                Latest command {latestCommand.status}. {latestCommand.error_message ?? 'No error message was provided.'}
              </div>
            )}

            {actionMessage && <div className="alert alert--neutral">{actionMessage}</div>}
            {actionError && <div className="alert alert--danger">{actionError}</div>}
          </div>

          {device.type === 'fence_controller' ? (
            <div className="stack">
              <div>
                <p className="eyebrow">Fence Controls</p>
                <p className="section-copy">
                  Commands are inserted into device_commands. The UI does not assume success until the command is acknowledged.
                </p>
              </div>
              <div className="button-row">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void sendCommand('turn_on')}
                  disabled={isSending || waitingForConfirmation}
                >
                  Turn On
                </button>
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => void sendCommand('turn_off')}
                  disabled={isSending || waitingForConfirmation}
                >
                  Turn Off
                </button>
              </div>
            </div>
          ) : (
            <div className="alert alert--neutral">
              Control buttons are only enabled for fence controllers in this MVP.
            </div>
          )}
        </article>

        <article className="panel detail-card stack">
          <div>
            <p className="eyebrow">Realtime Activity</p>
            <h2>Recent Device Events</h2>
          </div>

          {events.length === 0 ? (
            <div className="empty-state">No events reported yet for this device.</div>
          ) : (
            <ul className="event-list">
              {events.map((event) => (
                <li key={event.id} className="event-item">
                  <span className="label">{humanizeToken(event.event_type)}</span>
                  <p>{event.message}</p>
                  <p className="inline-note">{formatTimestamp(event.created_at)}</p>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>
    </section>
  )
}