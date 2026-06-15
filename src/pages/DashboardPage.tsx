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
  subscribeToCommandStatus,
  subscribeToAlerts,
  subscribeToDevices,
} from '../lib/dashboardData'
import { getDeviceOnlineStatus } from '../lib/deviceOnlineStatus'
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
    case 'freezer': {
      const temp = String(m.temperature ?? '—')
      const warn = String(m.warning_high_f ?? 5)
      const alarm = String(m.alarm_high_f ?? 10)
      const batt = m.battery_percent === null || m.battery_percent === undefined
        ? 'n/a'
        : `${String(m.battery_percent)}%`
      return `${temp} · Warn>${warn}°F · Alarm>${alarm}°F · Batt ${batt}`
    }
    case 'weather':   return `${String(m.temperature ?? 'â€”')}${m.summary ? ' Â· ' + String(m.summary) : ''}`
    case 'driveway':  return String(m.status ?? 'â€”')
    case 'gateway':   return `${String(m.nodes_online ?? 0)} nodes online`
    default:          return 'â€”'
  }
}

function sparklinePath(points: number[], width = 120, height = 28): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M 0 ${height / 2} L ${width} ${height / 2}`

  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = Math.max(max - min, 0.0001)
  const step = width / (points.length - 1)

  return points
    .map((p, i) => {
      const x = i * step
      const y = height - ((p - min) / span) * (height - 2) - 1
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
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
  const [browserOnline, setBrowserOnline] = useState<boolean>(navigator.onLine)
  const [networkHint, setNetworkHint] = useState<string | null>(null)
  const [lastSuccessfulCommandAt, setLastSuccessfulCommandAt] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(() => new Date())
  const [liveWeather, setLiveWeather] = useState<LiveWeather | null>(null)
  const timersRef = useRef<number[]>([])
  const fencePowerRef = useRef<'ON' | 'OFF' | null>(null)
  const rearmSuppressedRef = useRef(false)
  const rearmCycledRef = useRef(false)
  const rearmTimerRef = useRef<number | null>(null)
  const commandStatusUnsubRef = useRef<(() => void) | null>(null)
  const commandTimeoutTimersRef = useRef<number[]>([])

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
    function updateNetworkState() {
      setBrowserOnline(navigator.onLine)
      const conn = (navigator as Navigator & {
        connection?: { effectiveType?: string; downlink?: number; rtt?: number }
      }).connection

      if (!navigator.onLine) {
        setNetworkHint('Offline: phone has no internet connection.')
        return
      }

      if (!conn) {
        setNetworkHint(null)
        return
      }

      const effectiveType = String(conn.effectiveType ?? '')
      const downlink = Number(conn.downlink ?? 0)
      const rtt = Number(conn.rtt ?? 0)

      if (effectiveType === '2g' || effectiveType === 'slow-2g' || rtt > 1000) {
        setNetworkHint(`Weak link (${effectiveType || 'unknown'}, rtt ${rtt || 0} ms, ${downlink || 0} Mbps). Command delivery may be delayed.`)
        return
      }

      setNetworkHint(null)
    }

    updateNetworkState()
    window.addEventListener('online', updateNetworkState)
    window.addEventListener('offline', updateNetworkState)
    const conn = (navigator as Navigator & {
      connection?: { addEventListener?: (name: string, cb: () => void) => void; removeEventListener?: (name: string, cb: () => void) => void }
    }).connection
    conn?.addEventListener?.('change', updateNetworkState)

    return () => {
      window.removeEventListener('online', updateNetworkState)
      window.removeEventListener('offline', updateNetworkState)
      conn?.removeEventListener?.('change', updateNetworkState)
    }
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
      commandStatusUnsubRef.current?.()
      commandTimeoutTimersRef.current.forEach((t) => window.clearTimeout(t))
      if (rearmTimerRef.current !== null) window.clearTimeout(rearmTimerRef.current)
    }
  }, [])

  // Rebuild the derived overview whenever devices change (from realtime or initial load).
  useEffect(() => {
    if (isSupabaseConfigured && devices.length > 0) {
      setOverview(buildOverview(devices))
    }
  }, [devices])

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
    const n = devices.filter((d) => getDeviceOnlineStatus(d).online).length
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
    const fenceConnection = fenceDevice
      ? getDeviceOnlineStatus(fenceDevice)
      : { online: false, label: 'OFFLINE' as const, lastSeenMs: 0, ageMs: null }
    const fenceTone = ((): DashboardTone => {
      if (!fenceConnection.online) return 'neutral'
      if (fenceContactor === 'STUCK ON') return 'danger'
      if (fenceContactor === 'FAILED')   return 'warning'
      if (overview.fenceLine.chargerPower === 'ON') return 'success'
      return 'neutral'
    })()
    const fenceStatus = (() => {
      const cmdStatus = overview.fenceLine.commandStatus ?? 'idle'
      if (cmdStatus === 'verifying' || cmdStatus === 'sent' || cmdStatus === 'acknowledged') return 'Checking\u2026'
      if (fenceContactor === 'STUCK ON') return 'Stuck On'
      if (fenceContactor === 'FAILED')   return 'Fault'
      return overview.fenceLine.chargerPower === 'ON' ? 'Secure' : 'Off'
    })()

    const all = [
      hasFence || !isSupabaseConfigured ? {
        icon: 'fence' as StatusCardIcon,
        label: 'Fence',
        status: `State: ${fenceStatus}`,
        detail: `Connection: ${fenceConnection.label} · ${overview.fenceLine.verificationNote}`,
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
        tone: overview.freezer.state === 'Critical'
          ? ('danger' as const)
          : overview.freezer.state === 'Warning'
            ? ('warning' as const)
            : ('info' as const),
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

  function clearCommandDeliveryTracking() {
    commandStatusUnsubRef.current?.()
    commandStatusUnsubRef.current = null
    commandTimeoutTimersRef.current.forEach((t) => window.clearTimeout(t))
    commandTimeoutTimersRef.current = []
  }

  function lifecycleMessage(status: string, target: 'ON' | 'OFF'): BannerState {
    if (status === 'pending') return { tone: 'info', message: 'Sending command...' }
    if (status === 'gateway_received') return { tone: 'info', message: 'Command queued. Waiting for gateway...' }
    if (status === 'sent_to_node') return { tone: 'info', message: 'Sent to Field Lynk...' }
    if (status === 'node_acknowledged') return { tone: 'info', message: 'Field Lynk acknowledged...' }
    if (status === 'verified') return { tone: 'success', message: `${target} confirmed.` }
    if (status === 'verification_failed') return { tone: 'danger', message: 'Command not physically verified. Please check device status.' }
    if (status === 'failed') return { tone: 'danger', message: 'Command failed to complete.' }
    return { tone: 'info', message: 'Sending command...' }
  }

  function startFenceCommandTracking(command: CommandRecord, target: 'ON' | 'OFF') {
    clearCommandDeliveryTracking()
    setLatestCommand(command)
    setBanner(lifecycleMessage(command.status, target))

    const statusSeen = new Set<string>([command.status])

    const t15 = window.setTimeout(() => {
      if (!statusSeen.has('gateway_received')) {
        setBanner({ tone: 'warning', message: 'Command queued, but gateway has not picked it up yet.' })
      }
    }, 15_000)
    const t30 = window.setTimeout(() => {
      if (!statusSeen.has('node_acknowledged')) {
        setBanner({ tone: 'warning', message: 'Gateway did not receive confirmation from Field Lynk.' })
      }
    }, 30_000)
    const t45 = window.setTimeout(() => {
      if (!statusSeen.has('verified')) {
        setBanner({ tone: 'danger', message: 'Command not physically verified. Please check device status.' })
      }
    }, 45_000)
    const tPoll = window.setInterval(async () => {
      if (!supabase) return
      const { data, error } = await supabase
        .from('device_commands')
        .select('id, device_id, command, command_type, payload, status, created_at, sent_at, acknowledged_at, confirmed_at, failure_reason')
        .eq('id', command.id)
        .maybeSingle()
      if (error || !data) return

      const row = data as Record<string, unknown>
      const rawCmd = String(row.command ?? row.command_type ?? '').toLowerCase()
      const mappedType: CommandRecord['command_type'] =
        rawCmd === 'turn_on' ? 'FENCE_TURN_ON'
        : rawCmd === 'turn_off' ? 'FENCE_TURN_OFF'
        : rawCmd === 'fence_turn_on' ? 'FENCE_TURN_ON'
        : rawCmd === 'fence_turn_off' ? 'FENCE_TURN_OFF'
        : 'FENCE_TEST_RELAY'

      const next: CommandRecord = {
        id: String(row.id),
        target_device_id: String(row.device_id ?? ''),
        command_type: mappedType,
        payload: (row.payload as Record<string, string | number | boolean>) ?? {},
        status: String(row.status ?? 'pending') as CommandRecord['status'],
        requested_by: 'dashboard',
        created_at: String(row.created_at ?? new Date().toISOString()),
        sent_at: (row.sent_at as string | null) ?? null,
        acknowledged_at: (row.acknowledged_at as string | null) ?? null,
        confirmed_at: (row.confirmed_at as string | null) ?? null,
        failure_reason: (row.failure_reason as string | null) ?? null,
      }

      statusSeen.add(next.status)
      setLatestCommand(next)
      setBanner(lifecycleMessage(next.status, target))
      if (next.status === 'verified') {
        setLastSuccessfulCommandAt(new Date().toISOString())
        clearCommandDeliveryTracking()
      }
      if (next.status === 'verification_failed' || next.status === 'failed') {
        clearCommandDeliveryTracking()
      }
    }, 4000)

    commandTimeoutTimersRef.current = [t15, t30, t45, tPoll]

    commandStatusUnsubRef.current = subscribeToCommandStatus(command.id, (next) => {
      statusSeen.add(next.status)
      setLatestCommand(next)
      setBanner(lifecycleMessage(next.status, target))
      if (next.status === 'verified') {
        setLastSuccessfulCommandAt(new Date().toISOString())
        clearCommandDeliveryTracking()
      }
      if (next.status === 'verification_failed' || next.status === 'failed') {
        clearCommandDeliveryTracking()
      }
    })
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
    await sendFenceCommand('FENCE_TURN_ON')
  }

  async function handleFenceOff() {
    await sendFenceCommand('FENCE_TURN_OFF')
  }

  async function sendFenceCommand(commandType: 'FENCE_TURN_ON' | 'FENCE_TURN_OFF') {
    const fence = devices.find((d) => d.type === 'fence')
    if (!fence) return

    const target = commandType === 'FENCE_TURN_ON' ? 'ON' : 'OFF'

    if (!navigator.onLine) {
      setBanner({ tone: 'danger', message: 'No phone internet connection. Command was not sent.' })
      return
    }

    if (isSupabaseConfigured) {
      const clientCommandId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.floor(Math.random() * 100000)}`)
      setBanner({ tone: 'info', message: 'Sending command...' })

      const sendPromise = createLiveCommand(
        { target_device_id: fence.id, command_type: commandType, payload: {}, requested_by: 'dashboard' },
        { clientCommandId },
      )
      const timeoutPromise = new Promise<{ command: CommandRecord | null; error: string | null }>((resolve) => {
        window.setTimeout(() => resolve({ command: null, error: 'timeout' }), 8000)
      })

      const { command, error } = await Promise.race([sendPromise, timeoutPromise])
      if (error || !command) {
        setBanner({ tone: 'danger', message: 'Command not sent. Poor connection or server unreachable.' })
        return
      }

      setBanner({ tone: 'info', message: 'Command queued. Waiting for gateway...' })
      startFenceCommandTracking(command, target)
    } else {
      await createCommand({ target_device_id: fence.id, command_type: commandType, payload: {}, requested_by: 'home-tablet' })
      setBanner({ tone: 'info', message: `${target} command sent.` })
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
        void sendFenceCommand('FENCE_TURN_ON')
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
  const gatewayDevice = devices.find((d) => d.type === 'gateway')
  const fieldNodeDevice = devices.find((d) => d.type === 'fence')
  const gatewaySeen = gatewayDevice?.last_seen
    ? `${new Date(gatewayDevice.last_seen).toLocaleTimeString()} (${getDeviceOnlineStatus(gatewayDevice).label})`
    : 'Unknown'
  const fieldSeen = fieldNodeDevice?.last_seen
    ? `${new Date(fieldNodeDevice.last_seen).toLocaleTimeString()} (${getDeviceOnlineStatus(fieldNodeDevice).label})`
    : 'Unknown'

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
                {device.type === 'freezer' && Array.isArray(device.metadata.trend_points) && device.metadata.trend_points.length > 1 && (
                  <div className="device-tile__sparkline" aria-hidden="true">
                    <svg viewBox="0 0 120 28" preserveAspectRatio="none">
                      <path d={sparklinePath(device.metadata.trend_points as number[])} />
                    </svg>
                  </div>
                )}
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
            browserConnection={browserOnline ? 'Online' : 'Offline'}
            networkHint={networkHint ?? undefined}
            lastSuccessfulCommand={lastSuccessfulCommandAt ? new Date(lastSuccessfulCommandAt).toLocaleTimeString() : undefined}
            gatewayLastSeen={gatewaySeen}
            fieldNodeLastSeen={fieldSeen}
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
