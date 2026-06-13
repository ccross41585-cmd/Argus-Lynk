import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Pencil, X, Check } from 'lucide-react'
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
import { getDeviceOnlineStatus } from '../lib/deviceOnlineStatus'
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

type FreezerLogPoint = {
  temperature_f: number
  created_at: string
}

type FreezerSettings = {
  temp_alarm_high_f: number
  temp_warning_high_f: number
  alert_delay_minutes: number
  heartbeat_minutes: number
  offline_after_minutes: number
  logging_interval_minutes: number
  enabled: boolean
}

const DEVICE_SELECT_COLUMNS_FALLBACK = [
  'id',
  'tenant_id',
  'name',
  'type',
  'device_type',
  'status',
  'online',
  'confirmed_state',
  'desired_state',
  'last_seen',
  'last_seen_at',
  'updated_at',
  'location',
  'gateway_id',
  'battery_voltage',
  'rssi',
  'metadata',
].join(', ')

function getMissingDevicesColumn(message: string | undefined): string | null {
  const text = String(message ?? '')
  const direct = text.match(/column\s+devices\.([a-zA-Z0-9_]+)\s+does not exist/i)
  if (direct?.[1]) return direct[1]
  const schemaCache = text.match(/'([a-zA-Z0-9_]+)'\s+column\s+of\s+'devices'/i)
  if (schemaCache?.[1]) return schemaCache[1]
  return null
}

function isFreezerType(type: string | null | undefined) {
  const normalized = String(type ?? '').toLowerCase()
  return normalized === 'freezer_lynk' || normalized === 'freezer_alarm' || normalized === 'freezer'
}

function linePath(points: number[], width = 300, height = 90): string {
  if (points.length < 2) return ''
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = Math.max(max - min, 0.0001)
  const step = width / (points.length - 1)
  return points.map((p, i) => {
    const x = i * step
    const y = height - ((p - min) / span) * (height - 4) - 2
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')
}

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
          auxRaw={overview.fenceLine.auxRaw || undefined}
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
  const [alertHistory, setAlertHistory] = useState<Array<Record<string, unknown>>>([])
  const [freezerHistory24h, setFreezerHistory24h] = useState<FreezerLogPoint[]>([])
  const [freezerHistory7d, setFreezerHistory7d] = useState<FreezerLogPoint[]>([])
  const [freezerSettings, setFreezerSettings] = useState<FreezerSettings | null>(null)
  const [isSavingFreezerSettings, setIsSavingFreezerSettings] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [isEditingName, setIsEditingName] = useState(false)
  const [editNameValue, setEditNameValue] = useState('')
  const [isSavingName, setIsSavingName] = useState(false)

  useEffect(() => {
    if (!deviceId || !supabase) {
      setIsLoading(false)
      return
    }

    const client = supabase
    const routeDeviceId = deviceId

    let isActive = true

    async function loadDeviceWithFallback(id: string) {
      const baseColumns = [
        'id',
        'tenant_id',
        'name',
        'type',
        'device_type',
        'status',
        'online',
        'confirmed_state',
        'desired_state',
        'last_seen',
        'last_seen_at',
        'last_heartbeat',
        'updated_at',
        'location',
        'gateway_id',
        'battery_voltage',
        'rssi',
        'metadata',
      ]

      const selected = new Set(baseColumns)

      for (let attempt = 0; attempt < baseColumns.length; attempt++) {
        const selectColumns = Array.from(selected).join(', ')
        const response = await client
          .from('devices')
          .select(selectColumns)
          .eq('id', id)
          .single()

        if (!response.error) return response

        const missingColumn = getMissingDevicesColumn(response.error.message)
        if (!missingColumn || !selected.has(missingColumn)) return response
        selected.delete(missingColumn)
      }

      return client
        .from('devices')
        .select(DEVICE_SELECT_COLUMNS_FALLBACK)
        .eq('id', id)
        .single()
    }

    async function loadDeviceState() {
      setActionError(null)

      let [deviceResponse, commandResponse, eventResponse, alertsResponse] = await Promise.all([
        loadDeviceWithFallback(routeDeviceId),
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
        client
          .from('alerts')
          .select('*')
          .eq('device_id', deviceId)
          .order('created_at', { ascending: false })
          .limit(20),
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

      const loadedDevice = deviceResponse.data as unknown as Device
      setDevice(loadedDevice)
      setLatestCommand((commandResponse.data ?? null) as DeviceCommand | null)
      setEvents((eventResponse.data ?? []) as DeviceEvent[])
      setAlertHistory((alertsResponse.data ?? []) as Array<Record<string, unknown>>)

      if (isFreezerType(loadedDevice.type)) {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

        const [historyRes, settingsRes] = await Promise.all([
          client
            .from('freezer_temperature_logs')
            .select('temperature_f, created_at')
            .eq('device_id', loadedDevice.id)
            .gte('created_at', sevenDaysAgo)
            .order('created_at', { ascending: true })
            .limit(3000),
          client
            .from('freezer_lynk_settings')
            .select('temp_alarm_high_f, temp_warning_high_f, alert_delay_minutes, heartbeat_minutes, offline_after_minutes, logging_interval_minutes, enabled')
            .eq('device_id', loadedDevice.id)
            .maybeSingle(),
        ])

        if (!historyRes.error && historyRes.data) {
          const points = historyRes.data as FreezerLogPoint[]
          setFreezerHistory7d(points)
          setFreezerHistory24h(points.filter((p) => p.created_at >= oneDayAgo))
        }

        if (!settingsRes.error && settingsRes.data) {
          setFreezerSettings(settingsRes.data as FreezerSettings)
        }
      } else {
        setFreezerHistory24h([])
        setFreezerHistory7d([])
        setFreezerSettings(null)
      }

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

  function startEditName() {
    if (!device) return
    setEditNameValue(device.name)
    setIsEditingName(true)
  }

  function cancelEditName() {
    setIsEditingName(false)
    setEditNameValue('')
  }

  async function saveDeviceName() {
    if (!supabase || !device || !editNameValue.trim()) return
    setIsSavingName(true)
    const { error } = await supabase
      .from('devices')
      .update({ name: editNameValue.trim() })
      .eq('id', device.id)
    setIsSavingName(false)
    if (error) {
      setActionError(`Failed to rename device: ${error.message}`)
    } else {
      setDevice((d) => d ? { ...d, name: editNameValue.trim() } : d)
      setActionMessage('Device name updated.')
    }
    setIsEditingName(false)
  }

  async function saveFreezerSettings() {
    if (!supabase || !device || !freezerSettings) return
    setIsSavingFreezerSettings(true)
    const { error } = await supabase
      .from('freezer_lynk_settings')
      .upsert({
        device_id: device.id,
        temp_alarm_high_f: freezerSettings.temp_alarm_high_f,
        temp_warning_high_f: freezerSettings.temp_warning_high_f,
        alert_delay_minutes: freezerSettings.alert_delay_minutes,
        heartbeat_minutes: freezerSettings.heartbeat_minutes,
        offline_after_minutes: freezerSettings.offline_after_minutes,
        logging_interval_minutes: freezerSettings.logging_interval_minutes,
        enabled: freezerSettings.enabled,
      })
    setIsSavingFreezerSettings(false)
    if (error) {
      setActionError(`Failed to save freezer settings: ${error.message}`)
      return
    }
    setActionMessage('Freezer Lynk settings updated.')
  }

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

  const isFreezerDevice = useMemo(() => isFreezerType(device?.type), [device?.type])
  const onlineStatus = useMemo(
    () => (device ? getDeviceOnlineStatus(device) : null),
    [device],
  )
  const freezerCurrentTemp = freezerHistory24h.length > 0
    ? freezerHistory24h[freezerHistory24h.length - 1].temperature_f
    : null
  const freezer24hPath = linePath(freezerHistory24h.map((p) => p.temperature_f))
  const freezer7dPath = linePath(freezerHistory7d.map((p) => p.temperature_f))

  useEffect(() => {
    if (!device) return
    const type = String(device.device_type ?? device.type ?? '').toLowerCase()
    if (!type.includes('fence')) return
    console.log('[ONLINE STATUS]', device.name, {
      onlineField: device.online,
      last_seen: device.last_seen,
      last_heartbeat: device.last_heartbeat,
      updated_at: device.updated_at,
      computed: getDeviceOnlineStatus(device),
    })
  }, [device])

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
        {isEditingName ? (
          <div className="device-name-edit">
            <input
              className="device-name-edit__input"
              value={editNameValue}
              onChange={(e) => setEditNameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveDeviceName(); if (e.key === 'Escape') cancelEditName() }}
              autoFocus
              maxLength={64}
            />
            <button type="button" className="device-name-edit__btn device-name-edit__btn--save" onClick={() => void saveDeviceName()} disabled={isSavingName} aria-label="Save name">
              <Check size={16} strokeWidth={2.2} />
            </button>
            <button type="button" className="device-name-edit__btn device-name-edit__btn--cancel" onClick={cancelEditName} aria-label="Cancel">
              <X size={16} strokeWidth={2.2} />
            </button>
          </div>
        ) : (
          <div className="device-name-display">
            <h1>{device.name}</h1>
            <button type="button" className="device-name-edit__trigger" onClick={startEditName} aria-label="Edit device name">
              <Pencil size={15} strokeWidth={2} />
            </button>
          </div>
        )}
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
            <StatusPill tone={onlineStatus?.online ? 'success' : 'danger'}>
              {onlineStatus?.label ?? 'OFFLINE'}
            </StatusPill>
          </div>

          <div className="key-value-grid">
            <div className="key-value-item">
              <span className="label">Confirmed State</span>
              <strong>{humanizeToken(device.confirmed_state)}</strong>
            </div>
            <div className="key-value-item">
              <span className="label">Connection</span>
              <strong>{onlineStatus?.label ?? 'OFFLINE'}</strong>
            </div>
            <div className="key-value-item">
              <span className="label">Desired State</span>
              <strong>{humanizeToken(device.desired_state)}</strong>
            </div>
            <div className="key-value-item">
              <span className="label">Last Seen</span>
              <strong>{formatTimestamp(device.last_seen ?? device.last_heartbeat ?? device.updated_at)}</strong>
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

      {isFreezerDevice && (
        <section className="detail-grid">
          <article className="panel detail-card stack">
            <div>
              <p className="eyebrow">Freezer Lynk</p>
              <h2>Temperature & Thresholds</h2>
            </div>

            <div className="key-value-grid">
              <div className="key-value-item">
                <span className="label">Current Temp</span>
                <strong>{freezerCurrentTemp === null ? '—' : `${freezerCurrentTemp.toFixed(1)}°F`}</strong>
              </div>
              <div className="key-value-item">
                <span className="label">Samples (24h)</span>
                <strong>{freezerHistory24h.length}</strong>
              </div>
              <div className="key-value-item">
                <span className="label">Alarm Threshold</span>
                <strong>{freezerSettings ? `${freezerSettings.temp_alarm_high_f.toFixed(1)}°F` : '—'}</strong>
              </div>
              <div className="key-value-item">
                <span className="label">Warning Threshold</span>
                <strong>{freezerSettings ? `${freezerSettings.temp_warning_high_f.toFixed(1)}°F` : '—'}</strong>
              </div>
            </div>

            {freezerSettings && (
              <div className="stack">
                <div className="key-value-grid">
                  <label className="key-value-item">
                    <span className="label">Alarm °F</span>
                    <input
                      className="settings-location-input"
                      type="number"
                      step="0.1"
                      value={freezerSettings.temp_alarm_high_f}
                      onChange={(e) => setFreezerSettings((s) => s ? { ...s, temp_alarm_high_f: Number(e.target.value) } : s)}
                    />
                  </label>
                  <label className="key-value-item">
                    <span className="label">Warning °F</span>
                    <input
                      className="settings-location-input"
                      type="number"
                      step="0.1"
                      value={freezerSettings.temp_warning_high_f}
                      onChange={(e) => setFreezerSettings((s) => s ? { ...s, temp_warning_high_f: Number(e.target.value) } : s)}
                    />
                  </label>
                  <label className="key-value-item">
                    <span className="label">Alert Delay (min)</span>
                    <input
                      className="settings-location-input"
                      type="number"
                      min={1}
                      value={freezerSettings.alert_delay_minutes}
                      onChange={(e) => setFreezerSettings((s) => s ? { ...s, alert_delay_minutes: Number(e.target.value) } : s)}
                    />
                  </label>
                  <label className="key-value-item">
                    <span className="label">Offline After (min)</span>
                    <input
                      className="settings-location-input"
                      type="number"
                      min={1}
                      value={freezerSettings.offline_after_minutes}
                      onChange={(e) => setFreezerSettings((s) => s ? { ...s, offline_after_minutes: Number(e.target.value) } : s)}
                    />
                  </label>
                </div>

                <button
                  type="button"
                  className="primary-button"
                  disabled={isSavingFreezerSettings}
                  onClick={() => void saveFreezerSettings()}
                >
                  {isSavingFreezerSettings ? 'Saving…' : 'Save Settings'}
                </button>
              </div>
            )}
          </article>

          <article className="panel detail-card stack">
            <div>
              <p className="eyebrow">Reading History</p>
              <h2>Last 24h & Last 7d</h2>
            </div>

            <div>
              <p className="label" style={{ marginBottom: 6 }}>24 Hours</p>
              {freezer24hPath ? (
                <svg viewBox="0 0 300 90" className="freezer-detail-chart" preserveAspectRatio="none">
                  <path d={freezer24hPath} />
                </svg>
              ) : <div className="empty-state">Not enough points yet.</div>}
            </div>

            <div>
              <p className="label" style={{ marginBottom: 6 }}>7 Days</p>
              {freezer7dPath ? (
                <svg viewBox="0 0 300 90" className="freezer-detail-chart" preserveAspectRatio="none">
                  <path d={freezer7dPath} />
                </svg>
              ) : <div className="empty-state">No 7-day history yet.</div>}
            </div>

            <div>
              <p className="eyebrow" style={{ marginBottom: 8 }}>Alert History</p>
              {alertHistory.length === 0 ? (
                <div className="empty-state">No alerts yet for this freezer.</div>
              ) : (
                <ul className="event-list">
                  {alertHistory.map((item) => (
                    <li key={String(item.id)} className="event-item">
                      <span className="label">{String(item.severity ?? 'info')}</span>
                      <p>{String(item.message ?? '')}</p>
                      <p className="inline-note">{formatTimestamp(String(item.created_at ?? ''))}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </article>
        </section>
      )}
    </section>
  )
}