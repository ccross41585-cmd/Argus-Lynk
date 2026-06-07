import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, Bell, Cloud, Cpu, Droplets, Server, Snowflake, ToggleRight, Zap } from 'lucide-react'
import { AlertsPanel } from '../components/dashboard/AlertsPanel'
import { DashboardHeader } from '../components/dashboard/DashboardHeader'
import { LongRunAlertModal } from '../components/dashboard/LongRunAlertModal'
import { QuickActionsPanel } from '../components/dashboard/QuickActionsPanel'
import { StatusCard, type StatusCardIcon } from '../components/dashboard/StatusCard'
import { CONDITION_ICON } from '../components/dashboard/WeatherCard'
import { StatusPill } from '../components/StatusPill'
import {
  acknowledgeAlert,
  createCommand,
  getAlerts,
  getDashboardStatus,
  getDevices,
  silenceAlert,
} from '../lib/dashboardMock'
import {
  acknowledgeLiveAlert,
  buildOverview,
  createLiveCommand,
  generateContactorAlerts,
  getLiveDashboard,
  getLiveDevices,
  silenceLiveAlert,
  subscribeToAlerts,
  subscribeToDevices,
} from '../lib/dashboardData'
import { isSupabaseConfigured, supabase } from '../lib/supabase'
import { loadUserProfile } from '../lib/userProfile'
import { fetchWeather, type LiveWeather } from '../lib/weather'
import type {
  AlertRecord,
  CommandRecord,
  DashboardDevice,
  DashboardOverview,
  DashboardTone,
} from '../types/dashboard'

const mockShutoffWillConfirm = true

type ModalPhase = 'question' | 'extended' | 'silenced' | 'awaiting-confirmation' | 'confirmed' | 'failed'

type BannerState = {
  tone: DashboardTone
  message: string
}

function formatClock(value: Date) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(value)
}

function cardTone(status: string): DashboardTone {
  if (status === 'critical' || status === 'Alert' || status === 'Offline' || status === 'Node Offline') return 'danger'
  if (status === 'warning' || status === 'Warning' || status === 'Long Run Alert') return 'warning'
  if (status === 'Motion Detected' || status === 'Normal') return 'info'
  return 'success'
}

function deviceStatusTone(status: string): DashboardTone {
  if (status === 'critical') return 'danger'
  if (status === 'warning') return 'warning'
  if (status === 'offline') return 'neutral'
  if (status === 'online') return 'success'
  return 'info'
}

function getKeyMetric(device: DashboardDevice): string {
  const m = device.metadata
  switch (device.type) {
    case 'fence':     return `Charger ${String(m.charger_power ?? 'â€”')}`
    case 'well_pump': return m.alert_state && m.alert_state !== 'Normal'
                        ? String(m.alert_state)
                        : `Runtime ${String(m.runtime ?? 'â€”')}`
    case 'freezer':   return String(m.temperature ?? 'â€”')
    case 'weather':   return `${String(m.temperature ?? 'â€”')}${m.summary ? ' Â· ' + String(m.summary) : ''}`
    case 'driveway':  return String(m.status ?? 'â€”')
    case 'gateway':   return `${String(m.nodes_online ?? 0)} nodes online`
    default:          return 'â€”'
  }
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

export function DashboardPage() {
  const navigate = useNavigate()
  const [overview, setOverview] = useState<DashboardOverview | null>(null)
  const [devices, setDevices] = useState<DashboardDevice[]>([])
  const [alerts, setAlerts] = useState<AlertRecord[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalPhase, setModalPhase] = useState<ModalPhase>('question')
  const [latestCommand, setLatestCommand] = useState<CommandRecord | null>(null)
  const [commandTimeline, setCommandTimeline] = useState<string[]>([])
  const [banner, setBanner] = useState<BannerState | null>(null)
  const [currentTime, setCurrentTime] = useState(() => new Date())
  const [liveWeather, setLiveWeather] = useState<LiveWeather | null>(null)
  const timersRef = useRef<number[]>([])
  const fencePowerRef = useRef<'ON' | 'OFF' | null>(null)
  const rearmSuppressedRef = useRef(false)
  const rearmCycledRef = useRef(false)
  const rearmTimerRef = useRef<number | null>(null)

  useEffect(() => {
    let isActive = true
    async function loadWeather() {
      try {
        const userId = (await supabase?.auth.getUser())?.data?.user?.id
        if (!userId) return
        const profile = await loadUserProfile(userId)
        if (!profile?.latitude || !profile?.longitude) return
        const weather = await fetchWeather(profile.latitude, profile.longitude)
        if (isActive) setLiveWeather(weather)
      } catch { /* silent */ }
    }
    void loadWeather()
    const interval = window.setInterval(() => { void loadWeather() }, 15 * 60 * 1000)
    return () => { isActive = false; window.clearInterval(interval) }
  }, [])

  useEffect(() => {
    document.title = 'Argus Lynk | Home'
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => setCurrentTime(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    let isActive = true
    async function load() {
      if (isSupabaseConfigured) {
        const { overview: ov, devices: devs, alerts: als } = await getLiveDashboard()
        if (!isActive) return
        setOverview(ov)
        setDevices(devs)
        setAlerts(als)
      } else {
        const [nextOverview, nextDevices, nextAlerts] = await Promise.all([
          getDashboardStatus(), getDevices(), getAlerts(),
        ])
        if (!isActive) return
        setOverview(nextOverview)
        setDevices(nextDevices)
        setAlerts(nextAlerts)
      }
      setIsLoading(false)
    }
    void load()

    // Live realtime updates when Supabase is configured
    const unsubscribeDevices = isSupabaseConfigured
      ? subscribeToDevices((updated) => {
          setDevices((prev) => {
            const idx = prev.findIndex((d) => d.id === updated.id)
            const next = idx === -1 ? [...prev, updated] : prev.map((d, i) => i === idx ? updated : d)
            // Regenerate synthetic contactor alerts whenever a device updates
            setAlerts((prevAlerts) => {
              const dbAlerts = prevAlerts.filter((a) => !a.id.startsWith('synth-'))
              return [...generateContactorAlerts(next, dbAlerts), ...dbAlerts]
            })
            return next
          })
        })
      : () => {}

    // Polling fallback: re-fetch devices every 30 s so the UI stays accurate
    // even if a realtime event was dropped (e.g. network blip, subscription lag).
    // This is the safety net — realtime still drives low-latency updates.
    const pollInterval = isSupabaseConfigured
      ? window.setInterval(async () => {
          if (!isActive) return
          const fresh = await getLiveDevices()
          if (!isActive) return
          setDevices((prev) => {
            // Only update devices that have actually changed to avoid unnecessary re-renders
            let changed = false
            const next = prev.map((d) => {
              const f = fresh.find((x) => x.id === d.id)
              if (!f) return d
              // Compare by serialising key fields rather than deep-equal
              const same =
                d.status === f.status &&
                (d.metadata as Record<string, unknown>)?.charger_power ===
                  (f.metadata as Record<string, unknown>)?.charger_power &&
                (d.metadata as Record<string, unknown>)?.contactor_feedback ===
                  (f.metadata as Record<string, unknown>)?.contactor_feedback
              if (same) return d
              changed = true
              return f
            })
            if (!changed) return prev
            setAlerts((prevAlerts) => {
              const dbAlerts = prevAlerts.filter((a) => !a.id.startsWith('synth-'))
              return [...generateContactorAlerts(next, dbAlerts), ...dbAlerts]
            })
            return next
          })
        }, 30_000)
      : 0

    // Realtime alert subscription: adds new DB alerts and fires a local
    // push notification for critical/warning alerts received while the app
    // is in the background (supplements the gateway's push edge function call).
    const unsubscribeAlerts = isSupabaseConfigured
      ? subscribeToAlerts(async (newAlert) => {
          setAlerts((prev) => {
            if (prev.some((a) => a.id === newAlert.id)) return prev
            return [newAlert, ...prev]
          })
          if (
            (newAlert.severity === 'critical' || newAlert.severity === 'warning') &&
            'serviceWorker' in navigator &&
            Notification.permission === 'granted'
          ) {
            const reg = await navigator.serviceWorker.getRegistration('/')
            if (reg) {
              await reg.showNotification(
                newAlert.severity === 'critical' ? '🚨 Argus Critical Alert' : '⚠️ Argus Alert',
                {
                  body: newAlert.message,
                  icon: '/app-icon2.png',
                  badge: '/app-icon2.png',
                  tag: `alert-${newAlert.id}`,
                  requireInteraction: true,
                  data: { url: `/alerts/${newAlert.id}`, alertId: newAlert.id },
                  actions: [
                    { action: 'open', title: 'View' },
                    { action: 'silence', title: 'Silence' },
                  ],
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any,
              )
            }
          }
        })
      : () => {}

    return () => {
      isActive = false
      unsubscribeDevices()
      unsubscribeAlerts()
      if (pollInterval) window.clearInterval(pollInterval)
      timersRef.current.forEach((t) => window.clearTimeout(t))
      if (rearmTimerRef.current !== null) window.clearTimeout(rearmTimerRef.current)
    }
  }, [])

  // Rebuild the derived overview whenever devices change (from realtime or initial load).
  useEffect(() => {
    if (isSupabaseConfigured && devices.length > 0) {
      setOverview(buildOverview(devices))
    }
  }, [devices])

  // Detect fence ON→OFF transitions and schedule a 1-minute rearm reminder.
  useEffect(() => {
    if (!overview) return
    const current = overview.fenceLine.chargerPower === 'ON' ? 'ON' as const : 'OFF' as const
    const prev = fencePowerRef.current
    fencePowerRef.current = current
    if (prev === null) return // initial load — no transition yet

    if (current === 'ON' && prev === 'OFF') {
      // Fence was armed — cancel any pending reminder
      if (rearmTimerRef.current !== null) {
        window.clearTimeout(rearmTimerRef.current)
        rearmTimerRef.current = null
      }
      // Track that the user rearmed after saying "Not Now"
      if (rearmSuppressedRef.current) rearmCycledRef.current = true
    }

    if (current === 'OFF' && prev === 'ON') {
      // Fence just turned off
      if (rearmCycledRef.current) {
        // They manually rearmed then turned off again — reset suppression
        rearmSuppressedRef.current = false
        rearmCycledRef.current = false
      }
      if (!rearmSuppressedRef.current) {
        // Schedule the reminder for 1 minute of being off
        rearmTimerRef.current = window.setTimeout(() => {
          rearmTimerRef.current = null
          void showRearmNotification()
        }, 60_000)
      }
    }
  }, [overview])

  const activeAlerts = useMemo(() => alerts.filter((a) => !a.resolved_at), [alerts])

  const priorityDevices = useMemo(() => {
    return devices
      .filter((d) => d.type !== 'gateway' && d.enabled !== false)
      .sort((a, b) => {
        const rank = (s: string) => s === 'critical' ? 0 : s === 'warning' ? 1 : 2
        const diff = rank(a.status) - rank(b.status)
        if (diff !== 0) return diff
        if (a.pinned && !b.pinned) return -1
        if (!a.pinned && b.pinned) return 1
        return (a.sort_order ?? 99) - (b.sort_order ?? 99)
      })
      .slice(0, 6)
  }, [devices])

  const nodesOnlineText = useMemo(() => {
    const n = devices.filter((d) => d.status !== 'offline' && d.status !== 'critical').length
    return `${n}/${devices.length}`
  }, [devices])

  const summaryCards = useMemo(() => {
    if (!overview) return []

    const installedTypes = new Set(devices.map((d) => d.type))
    const hasFence    = installedTypes.has('fence')
    const hasWellPump = installedTypes.has('well_pump')
    const hasFreezer  = installedTypes.has('freezer')
    const hasDriveway = installedTypes.has('driveway')

    const fenceDevice = devices.find((d) => d.type === 'fence')
    const fenceContactor = String(fenceDevice?.metadata.contactor_feedback ?? '').toUpperCase()
    const fenceTone = ((): DashboardTone => {
      if (fenceContactor === 'STUCK ON') return 'danger'
      if (fenceContactor === 'FAILED')   return 'warning'
      if (overview.fenceLine.chargerPower === 'ON') return 'success'
      return 'neutral'
    })()
    const fenceStatus = (() => {
      if (fenceContactor === 'STUCK ON') return 'Stuck On'
      if (fenceContactor === 'FAILED')   return 'Fault'
      return overview.fenceLine.chargerPower === 'ON' ? 'Secure' : 'Off'
    })()

    const all = [
      hasFence || !isSupabaseConfigured ? {
        icon: 'fence' as StatusCardIcon,
        label: 'Fence',
        status: fenceStatus,
        detail: overview.fenceLine.verificationNote,
        tone: fenceTone,
      } : null,
      hasWellPump || !isSupabaseConfigured ? {
        icon: 'pump' as StatusCardIcon,
        label: 'Well Pump',
        status: overview.wellPump.pumpPower === 'ON' ? 'Running' : 'Off',
        detail: `${overview.wellPump.runtime} runtime`,
        tone: overview.wellPump.alertState === 'Long Run Alert' ? ('warning' as const) : ('info' as const),
      } : null,
      hasFreezer || !isSupabaseConfigured ? {
        icon: 'freezer' as StatusCardIcon,
        label: 'Freezer',
        status: overview.freezer.temperature,
        detail: overview.freezer.state,
        tone: 'info' as const,
      } : null,
      hasDriveway || !isSupabaseConfigured ? {
        icon: 'driveway' as StatusCardIcon,
        label: 'Driveway',
        status: overview.drivewayAlarm.status === 'Clear' ? 'Clear' : 'Alert',
        detail: `Last trig ${overview.drivewayAlarm.lastTriggered}`,
        tone: cardTone(overview.drivewayAlarm.status),
      } : null,
      {
        icon: 'weather' as StatusCardIcon,
        label: 'Weather',
        status: liveWeather ? `${liveWeather.temperatureF}°F` : overview.weather.temperature,
        detail: liveWeather?.summary ?? overview.weather.summary,
        tone: 'success' as const,
        customIcon: liveWeather?.condition ? CONDITION_ICON[liveWeather.condition] : undefined,
      },
      {
        icon: 'nodes' as StatusCardIcon,
        label: 'Nodes',
        status: nodesOnlineText,
        detail: 'Field nodes reporting',
        tone: 'success' as const,
      },
    ]

    return all.filter(Boolean) as NonNullable<typeof all[number]>[]
  }, [nodesOnlineText, overview, liveWeather, devices])

  function clearCommandTimers() {
    timersRef.current.forEach((t) => window.clearTimeout(t))
    timersRef.current = []
  }

  function setWellPumpResolved() {
    const now = new Date().toISOString()
    setDevices((prev) =>
      prev.map((d) => d.type !== 'well_pump' ? d : {
        ...d, status: 'online' as const, last_seen: now,
        metadata: { ...d.metadata, runtime: '00 min 00 sec', relay_feedback: 'OFF', alert_state: 'Normal' },
      }),
    )
    setAlerts((prev) =>
      prev.map((a) => a.type !== 'well_pump_long_runtime' || a.resolved_at ? a : {
        ...a, acknowledged: true, resolved_at: now,
      }),
    )
    setOverview((cur) => cur ? {
      ...cur, lastUpdated: now,
      wellPump: { ...cur.wellPump, pumpPower: 'OFF', runtime: '00 min 00 sec', feedback: 'Contactor confirmed OFF', alertState: 'Normal' },
      system: { ...cur.system, awaitingConfirmations: 0, queueDepth: 1, lastCommand: 'Well pump shutoff confirmed.' },
    } : cur)
  }

  async function handleExtendRuntime() {
    const pump = devices.find((d) => d.type === 'well_pump')
    if (!pump) return
    const cmd = await createCommand({ target_device_id: pump.id, command_type: 'WELL_PUMP_EXTEND_RUNTIME', payload: { minutes: 45 }, requested_by: 'home-tablet' })
    setLatestCommand(cmd)
    setModalPhase('extended')
    setBanner({ tone: 'info', message: 'Runtime extended 45 minutes. Alert timer reset.' })
  }

  async function handleSilenceAlert() {
    const active = alerts.filter((a) => !a.resolved_at && !a.silenced_until)
    if (isSupabaseConfigured) {
      await Promise.all(active.map((a) => silenceLiveAlert(a.id)))
    } else {
      await Promise.all(active.map((a) => silenceAlert(a.id)))
    }
    setAlerts((prev) => prev.map((a) =>
      active.some((aa) => aa.id === a.id)
        ? { ...a, silenced_until: new Date(Date.now() + 30 * 60_000).toISOString() }
        : a,
    ))
    if (modalOpen) setModalPhase('silenced')
    setBanner({ tone: 'warning', message: 'Alerts silenced for 30 minutes.' })
  }

  async function handleWellPumpShutoff() {
    const pump = devices.find((d) => d.type === 'well_pump')
    if (!pump) return
    clearCommandTimers()
    const pending = await createCommand({ target_device_id: pump.id, command_type: 'WELL_PUMP_SHUTOFF', payload: { requested_state: 'OFF' }, requested_by: 'home-tablet' })
    setLatestCommand(pending)
    setModalPhase('awaiting-confirmation')
    setCommandTimeline([])
    setBanner({ tone: 'warning', message: 'Shutdown command sent. Waiting for field node confirmation...' })

    const t1 = window.setTimeout(() => {
      setLatestCommand((c) => c ? { ...c, status: 'sent', sent_at: new Date().toISOString() } : c)
      setCommandTimeline(['Command received'])
    }, 1000)
    const t2 = window.setTimeout(() => {
      setLatestCommand((c) => c ? { ...c, status: 'acknowledged', acknowledged_at: new Date().toISOString() } : c)
      setCommandTimeline(['Command received', 'Relay/contact feedback confirmed OFF'])
    }, 2200)
    const t3 = window.setTimeout(() => {
      if (mockShutoffWillConfirm) {
        setLatestCommand((c) => c ? { ...c, status: 'confirmed', confirmed_at: new Date().toISOString() } : c)
        setCommandTimeline(['Command received', 'Relay/contact feedback confirmed OFF', 'Pump power disabled'])
        setModalPhase('confirmed')
        setBanner({ tone: 'success', message: 'Well pump shutdown confirmed by field feedback.' })
        setWellPumpResolved()
      } else {
        setLatestCommand((c) => c ? { ...c, status: 'failed', failure_reason: 'Field confirmation timeout' } : c)
        setModalPhase('failed')
        setBanner({ tone: 'danger', message: 'Command sent, but shutdown confirmation was not received.' })
      }
    }, 3600)
    timersRef.current = [t1, t2, t3]
  }

  async function handleFenceOn() {
    const fence = devices.find((d) => d.type === 'fence')
    if (!fence) return
    if (isSupabaseConfigured) {
      const { error } = await createLiveCommand({ target_device_id: fence.id, command_type: 'FENCE_TURN_ON', payload: {}, requested_by: 'dashboard' })
      setBanner(error ? { tone: 'danger', message: `Failed to send ON command: ${error}` } : { tone: 'success', message: 'Fence arm command sent.' })
    } else {
      await createCommand({ target_device_id: fence.id, command_type: 'FENCE_TURN_ON', payload: {}, requested_by: 'home-tablet' })
      setBanner({ tone: 'success', message: 'Fence arm command sent.' })
    }
  }

  async function handleFenceOff() {
    const fence = devices.find((d) => d.type === 'fence')
    if (!fence) return
    if (isSupabaseConfigured) {
      const { error } = await createLiveCommand({ target_device_id: fence.id, command_type: 'FENCE_TURN_OFF', payload: {}, requested_by: 'dashboard' })
      setBanner(error ? { tone: 'danger', message: `Failed to send OFF command: ${error}` } : { tone: 'warning', message: 'Fence disarm command sent.' })
    } else {
      await createCommand({ target_device_id: fence.id, command_type: 'FENCE_TURN_OFF', payload: {}, requested_by: 'home-tablet' })
      setBanner({ tone: 'warning', message: 'Fence disarm command sent.' })
    }
  }

  async function showRearmNotification() {
    if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return
    const reg = await navigator.serviceWorker.getRegistration('/')
    if (!reg) return
    await reg.showNotification('Fence Reminder ⚡', {
      body: 'The fence has been off for 1 minute. Would you like to arm it now?',
      icon: '/app-icon2.png',
      badge: '/app-icon2.png',
      tag: 'argus-fence-rearm',
      requireInteraction: true,
      data: { url: '/' },
      actions: [
        { action: 'arm-fence', title: 'Arm Now' },
        { action: 'dismiss-fence', title: 'Not Now' },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  }

  // Listen for service worker messages (arm-fence / suppress from notification actions)
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    function onSWMessage(e: MessageEvent) {
      const msg = e.data as { type: string } | null
      if (!msg) return
      if (msg.type === 'FENCE_REARM_SUPPRESS') {
        rearmSuppressedRef.current = true
        rearmCycledRef.current = false
      }
      if (msg.type === 'FENCE_REARM') {
        const fence = devices.find((d) => d.type === 'fence')
        if (!fence) return
        void (isSupabaseConfigured
          ? createLiveCommand({ target_device_id: fence.id, command_type: 'FENCE_TURN_ON', payload: {}, requested_by: 'dashboard' })
              .then(({ error }) => setBanner(error
                ? { tone: 'danger', message: `Rearm failed: ${error}` }
                : { tone: 'success', message: 'Fence arm command sent.' }))
          : createCommand({ target_device_id: fence.id, command_type: 'FENCE_TURN_ON', payload: {}, requested_by: 'home-tablet' })
              .then(() => setBanner({ tone: 'success', message: 'Fence arm command sent.' }))
        )
      }
    }
    navigator.serviceWorker.addEventListener('message', onSWMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onSWMessage)
  }, [devices])

  async function handleAcknowledgeAlert(alertId: string) {
    if (isSupabaseConfigured) {
      await acknowledgeLiveAlert(alertId)
    } else {
      await acknowledgeAlert(alertId)
    }
    setAlerts((prev) => prev.map((a) => a.id === alertId ? { ...a, acknowledged: true } : a))
    setBanner({ tone: 'info', message: 'Alert acknowledged.' })
  }

  if (isLoading || !overview) {
    return (
      <section className="dashboard-page dashboard-page--home">
        <p className="eyebrow">Loading</p>
        <p className="muted-copy">Building home overviewâ€¦</p>
      </section>
    )
  }

  const nonGatewayDevices = devices.filter((d) => d.type !== 'gateway')

  return (
    <section className="dashboard-page dashboard-page--home">
      <DashboardHeader
        gatewayStatus={overview.gatewayStatus}
        networkStrength={overview.networkStrength}
        currentTime={formatClock(currentTime)}
      />

      {banner && <div className={`alert alert--${banner.tone}`}>{banner.message}</div>}

      <section className="status-card-grid">
        {summaryCards.map((card) => (
          <StatusCard
            key={card.label}
            {...card}
            {...(card.label === 'Fence' ? {
              onToggleOn: () => void handleFenceOn(),
              onToggleOff: () => void handleFenceOff(),
            } : {})}
          />
        ))}
      </section>

      <section className="overview-grid">
        {/* Left: compact device summary tiles */}
        <div className="device-summary-grid">
          {priorityDevices.map((device) => {
            const Icon = DEVICE_ICONS[device.type] ?? Server
            const tone = deviceStatusTone(device.status)
            return (
              <button
                key={device.id}
                type="button"
                className={`device-tile device-tile--${tone}`}
                onClick={() => void navigate(`/devices/${device.id}`)}
              >
                <div className="device-tile__head">
                  <span className="device-tile__icon-wrap">
                    <Icon size={14} aria-hidden="true" />
                  </span>
                  <span className="device-tile__name">{device.name}</span>
                  <StatusPill tone={tone}>{device.status}</StatusPill>
                </div>
                {device.location && (
                  <p className="device-tile__location">{device.location}</p>
                )}
                <p className="device-tile__metric">{getKeyMetric(device)}</p>
              </button>
            )
          })}
          {nonGatewayDevices.length > 6 && (
            <button
              type="button"
              className="device-tile device-tile--more"
              onClick={() => void navigate('/devices')}
            >
              <p className="device-tile__metric">+{nonGatewayDevices.length - 6} more</p>
              <p className="eyebrow">View All Devices</p>
            </button>
          )}
        </div>

        {/* Right: alerts + quick actions */}
        <aside className="field-controls-panel">
          <AlertsPanel
            alerts={activeAlerts}
            onOpenLongRunAlert={() => { setModalPhase('question'); setModalOpen(true) }}
            onAcknowledge={(id) => void handleAcknowledgeAlert(id)}
          />
          <div className="right-divider" />
          <QuickActionsPanel
            queueDepth={overview.system.queueDepth}
            awaitingConfirmations={overview.system.awaitingConfirmations}
            lastCommand={
              latestCommand
                ? `${latestCommand.command_type} Â· ${latestCommand.status}`
                : overview.system.lastCommand
            }
            onSilenceAlerts={() => void handleSilenceAlert()}
            onViewSystemHealth={() => void navigate('/system')}
          />
        </aside>
      </section>

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
    </section>
  )
}
