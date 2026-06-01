import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { DrivewayAlarmCard } from '../components/dashboard/DrivewayAlarmCard'
import { FenceControllerCard } from '../components/dashboard/FenceControllerCard'
import { FreezerCard } from '../components/dashboard/FreezerCard'
import { LongRunAlertModal } from '../components/dashboard/LongRunAlertModal'
import { WellPumpCard } from '../components/dashboard/WellPumpCard'
import { StatusPill } from '../components/StatusPill'
import {
  formatTimestamp,
  formatVoltage,
  humanizeToken,
  isPendingStatus,
} from '../lib/display'
import {
  acknowledgeAlert,
  createCommand,
  getAlerts,
  getDeviceById,
  getDashboardStatus,
  silenceAlert,
} from '../lib/dashboardMock'
import { isSupabaseConfigured, supabase } from '../lib/supabase'
import type { AlertRecord, CommandRecord, DashboardDevice, DashboardOverview } from '../types/dashboard'

type ModalPhase = 'question' | 'extended' | 'silenced' | 'awaiting-confirmation' | 'confirmed' | 'failed'

const mockShutoffWillConfirm = true

function LocalDeviceDetail({ deviceId }: { deviceId: string }) {
  const [device, setDevice] = useState<DashboardDevice | null>(null)
  const [overview, setOverview] = useState<DashboardOverview | null>(null)
  const [alerts, setAlerts] = useState<AlertRecord[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [banner, setBanner] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalPhase, setModalPhase] = useState<ModalPhase>('question')
  const [latestCommand, setLatestCommand] = useState<CommandRecord | null>(null)
  const [commandTimeline, setCommandTimeline] = useState<string[]>([])
  const timersRef = useRef<number[]>([])

  useEffect(() => {
    void Promise.all([getDeviceById(deviceId), getDashboardStatus(), getAlerts()]).then(
      ([dev, ov, al]) => {
        setDevice(dev)
        setOverview(ov)
        setAlerts(al)
        setIsLoading(false)
      },
    )
    return () => { timersRef.current.forEach((t) => window.clearTimeout(t)) }
  }, [deviceId])

  async function handleFenceCommand(command: 'FENCE_TURN_ON' | 'FENCE_TURN_OFF' | 'FENCE_TEST_RELAY') {
    if (!device) return
    const cmd = await createCommand({ target_device_id: device.id, command_type: command, payload: {}, requested_by: 'home-tablet' })
    setLatestCommand(cmd)
    const newPower = command === 'FENCE_TURN_ON' ? 'ON' as const : command === 'FENCE_TURN_OFF' ? 'OFF' as const : device.metadata.charger_power === 'ON' ? 'ON' as const : 'OFF' as const
    setDevice((d) => d ? { ...d, metadata: { ...d.metadata, charger_power: newPower, relay_feedback: newPower } } : d)
    setBanner(`Fence command sent: ${command}`)
  }

  async function handleExtendRuntime() {
    if (!device) return
    const cmd = await createCommand({ target_device_id: device.id, command_type: 'WELL_PUMP_EXTEND_RUNTIME', payload: { minutes: 45 }, requested_by: 'home-tablet' })
    setLatestCommand(cmd)
    setModalPhase('extended')
    setBanner('Runtime extended 45 minutes.')
  }

  async function handleSilenceAlert() {
    const active = alerts.filter((a) => !a.resolved_at && !a.silenced_until)
    await Promise.all(active.map((a) => silenceAlert(a.id)))
    setAlerts((prev) => prev.map((a) =>
      active.some((aa) => aa.id === a.id)
        ? { ...a, silenced_until: new Date(Date.now() + 30 * 60_000).toISOString() }
        : a,
    ))
    if (modalOpen) setModalPhase('silenced')
    setBanner('Alerts silenced for 30 minutes.')
  }

  async function handleWellPumpShutoff() {
    if (!device) return
    timersRef.current.forEach((t) => window.clearTimeout(t))
    const pending = await createCommand({ target_device_id: device.id, command_type: 'WELL_PUMP_SHUTOFF', payload: { requested_state: 'OFF' }, requested_by: 'home-tablet' })
    setLatestCommand(pending)
    setModalPhase('awaiting-confirmation')
    setCommandTimeline([])
    setBanner('Shutdown command sent…')
    const t1 = window.setTimeout(() => {
      setLatestCommand((c) => c ? { ...c, status: 'sent', sent_at: new Date().toISOString() } : c)
      setCommandTimeline(['Command received'])
    }, 1000)
    const t2 = window.setTimeout(() => {
      setLatestCommand((c) => c ? { ...c, status: 'acknowledged', acknowledged_at: new Date().toISOString() } : c)
      setCommandTimeline(['Command received', 'Relay feedback confirmed OFF'])
    }, 2200)
    const t3 = window.setTimeout(() => {
      if (mockShutoffWillConfirm) {
        setLatestCommand((c) => c ? { ...c, status: 'confirmed', confirmed_at: new Date().toISOString() } : c)
        setCommandTimeline(['Command received', 'Relay feedback confirmed OFF', 'Pump power disabled'])
        setModalPhase('confirmed')
        setBanner('Well pump shutdown confirmed.')
        const now = new Date().toISOString()
        setDevice((d) => d ? { ...d, status: 'online', last_seen: now, metadata: { ...d.metadata, runtime: '00 min 00 sec', relay_feedback: 'OFF', alert_state: 'Normal' } } : d)
      } else {
        setLatestCommand((c) => c ? { ...c, status: 'failed', failure_reason: 'Timeout' } : c)
        setModalPhase('failed')
        setBanner('Command sent, but confirmation was not received.')
      }
    }, 3600)
    timersRef.current = [t1, t2, t3]
  }

  if (isLoading) {
    return <div className="panel"><p className="eyebrow">Loading…</p></div>
  }

  if (!device) {
    return (
      <div className="panel">
        <Link to="/devices" className="back-link">← All Devices</Link>
        <div className="alert alert--danger">Device not found.</div>
      </div>
    )
  }

  const activeAlerts = alerts.filter((a) => !a.resolved_at && a.device_id === device.id)

  return (
    <div className="device-detail-page">
      <div className="device-detail-page__nav">
        <Link to="/devices" className="back-link">← All Devices</Link>
      </div>
      <div className="device-detail-page__header">
        <p className="eyebrow">{device.type.replace('_', ' ')}</p>
        <h1 className="device-detail-page__title">{device.name}</h1>
        {device.location && <p className="muted-copy">{device.location}</p>}
        <div style={{ marginTop: 6 }}>
          <StatusPill tone={device.status === 'warning' ? 'warning' : device.status === 'critical' ? 'danger' : device.status === 'offline' ? 'neutral' : 'success'}>
            {device.status}
          </StatusPill>
        </div>
      </div>

      {banner && <div className="alert alert--info" style={{ marginBottom: 12 }}>{banner}</div>}

      {device.type === 'well_pump' && overview && (
        <WellPumpCard
          pumpPower={overview.wellPump.pumpPower}
          runtime={overview.wellPump.runtime}
          fieldNode={overview.wellPump.fieldNode}
          feedback={overview.wellPump.feedback}
          alertState={overview.wellPump.alertState}
          latestCommand={latestCommand}
          onShutOff={() => { setModalPhase('question'); setModalOpen(true) }}
          onRestart={async () => { setBanner('Restart command sent.') }}
          onViewDetails={() => { /* already on detail page */ }}
        />
      )}

      {device.type === 'fence' && overview && (
        <FenceControllerCard
          chargerPower={overview.fenceLine.chargerPower}
          fieldNode={overview.fenceLine.fieldNode}
          lastCommand={overview.fenceLine.lastCommand}
          feedback={overview.fenceLine.feedback}
          note={overview.fenceLine.verificationNote}
          latestCommand={latestCommand}
          onTurnOn={() => void handleFenceCommand('FENCE_TURN_ON')}
          onTurnOff={() => void handleFenceCommand('FENCE_TURN_OFF')}
          onTestRelay={() => void handleFenceCommand('FENCE_TEST_RELAY')}
        />
      )}

      {device.type === 'freezer' && overview && (
        <FreezerCard
          temperature={overview.freezer.temperature}
          safeRange={overview.freezer.safeRange}
          node={overview.freezer.node}
          lastUpdated={overview.freezer.lastUpdatedLabel}
          alertState={overview.freezer.state}
          onViewDetails={() => { /* already on detail page */ }}
        />
      )}

      {device.type === 'driveway' && overview && (
        <DrivewayAlarmCard
          status={overview.drivewayAlarm.status}
          lastTriggered={overview.drivewayAlarm.lastTriggered}
          node={overview.drivewayAlarm.node}
        />
      )}

      {device.type !== 'well_pump' && device.type !== 'fence' && device.type !== 'freezer' && device.type !== 'driveway' && device.type !== 'weather' && (
        <div className="compact-card">
          <p className="eyebrow">Device Info</p>
          <div className="data-rows">
            {Object.entries(device.metadata).map(([k, v]) => (
              <div key={k} className="data-row">
                <span className="label">{k.replace(/_/g, ' ')}</span>
                <strong className="value-mono">{String(v ?? '—')}</strong>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeAlerts.length > 0 && (
        <div className="compact-card">
          <p className="eyebrow">Active Alerts for this Device</p>
          {activeAlerts.map((a) => (
            <div key={a.id} className="alert alert--warning" style={{ marginBottom: 8 }}>
              {a.message}
              {!a.acknowledged && (
                <button type="button" className="ghost-button btn-sm" style={{ marginLeft: 12 }}
                  onClick={() => void acknowledgeAlert(a.id).then(() => setAlerts((prev) => prev.map((al) => al.id === a.id ? { ...al, acknowledged: true } : al)))}
                >
                  Acknowledge
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {device.type === 'well_pump' && (
        <LongRunAlertModal
          open={modalOpen}
          phase={modalPhase}
          command={latestCommand}
          timeline={commandTimeline}
          onClose={() => setModalOpen(false)}
          onExtend={() => void handleExtendRuntime()}
          onShutOff={() => void handleWellPumpShutoff()}
          onSilence={() => void handleSilenceAlert()}
        />
      )}
    </div>
  )
}
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
    return <LocalDeviceDetail deviceId={deviceId ?? ''} />
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
        <Link to="/devices" className="back-link">
          Back to Devices
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
        <Link to="/devices" className="back-link">
          Back to Devices
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