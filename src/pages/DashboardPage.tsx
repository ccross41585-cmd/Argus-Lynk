import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, Bell, Cloud, Cpu, Droplets, Server, Snowflake, ToggleRight, Zap } from 'lucide-react'
import { AlertsPanel } from '../components/dashboard/AlertsPanel'
import { DashboardHeader } from '../components/dashboard/DashboardHeader'
import { FieldLynkControlSheet } from '../components/dashboard/FieldLynkControlSheet'
import { FreezerQuickDetailSheet } from '../components/dashboard/FreezerQuickDetailSheet'
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

type FreezerRange = '24h' | '7d' | '30d' | 'custom'

type FreezerTrendPoint = {
  temperatureF: number
  timestamp: string
}

type FreezerTempRow = {
  temperature_f: number
  created_at: string
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

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const DEVICE_ICONS: Record<string, React.ElementType> = {
  gateway: Server,
  fence: Zap,
  well_pump: Droplets,
  freezer: Snowflake,
  weather: Cloud,
  driveway: Bell,
  relay_node: ToggleRight,
  sensor_node: Activity,
  custom: Cpu,
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
  const [isFieldSheetOpen, setIsFieldSheetOpen] = useState(false)
  const [isFreezerSheetOpen, setIsFreezerSheetOpen] = useState(false)
  const [selectedFreezerId, setSelectedFreezerId] = useState<string | null>(null)
  const [freezerRange, setFreezerRange] = useState<FreezerRange>('24h')
  const [freezerCustomStart, setFreezerCustomStart] = useState('')
  const [freezerCustomEnd, setFreezerCustomEnd] = useState('')
  const [freezerTrendPoints, setFreezerTrendPoints] = useState<FreezerTrendPoint[]>([])
  const [isFreezerTrendLoading, setIsFreezerTrendLoading] = useState(false)
  const [isFenceCommandSending, setIsFenceCommandSending] = useState(false)
  const [fenceCommandProgress, setFenceCommandProgress] = useState('Waiting for command...')
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

  const selectedFreezer = useMemo(() => {
    if (selectedFreezerId) {
      const byId = devices.find((device) => device.id === selectedFreezerId && device.type === 'freezer')
      if (byId) return byId
    }
    return devices.find((device) => device.type === 'freezer') ?? null
  }, [devices, selectedFreezerId])

  useEffect(() => {
    let isActive = true

    async function loadFreezerTrend() {
      if (!isFreezerSheetOpen || !selectedFreezer) return

      setIsFreezerTrendLoading(true)

      const rangeMs = freezerRange === '24h'
        ? 24 * 60 * 60 * 1000
        : freezerRange === '7d'
          ? 7 * 24 * 60 * 60 * 1000
          : 30 * 24 * 60 * 60 * 1000

      if (!isSupabaseConfigured || !supabase) {
        const trend = Array.isArray(selectedFreezer.metadata.trend_points)
          ? (selectedFreezer.metadata.trend_points as number[])
          : []
        const now = Date.now()
        const points = trend.map((temp, index) => {
          const at = trend.length <= 1
            ? now
            : now - rangeMs + (index / (trend.length - 1)) * rangeMs
          return { temperatureF: Number(temp), timestamp: new Date(at).toISOString() }
        })
        if (isActive) {
          setFreezerTrendPoints(points)
          setIsFreezerTrendLoading(false)
        }
        return
      }

      const query = supabase
        .from('freezer_temperature_logs')
        .select('temperature_f, created_at')
        .eq('device_id', selectedFreezer.id)
        .order('created_at', { ascending: true })
        .limit(5000)

      const nowIso = new Date().toISOString()

      const constrained = (() => {
        if (freezerRange === '24h') {
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
          return query.gte('created_at', since)
        }
        if (freezerRange === '7d') {
          const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
          return query.gte('created_at', since)
        }
        if (freezerRange === '30d') {
          const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
          return query.gte('created_at', since)
        }

        let customQuery = query
        if (freezerCustomStart) {
          customQuery = customQuery.gte('created_at', new Date(`${freezerCustomStart}T00:00:00`).toISOString())
        } else {
          customQuery = customQuery.gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
        }

        if (freezerCustomEnd) {
          customQuery = customQuery.lte('created_at', new Date(`${freezerCustomEnd}T23:59:59`).toISOString())
        } else {
          customQuery = customQuery.lte('created_at', nowIso)
        }

        return customQuery
      })()

      const { data } = await constrained
      if (!isActive) return

      const points = (data ?? []).map((row) => {
        const typed = row as FreezerTempRow
        return {
          temperatureF: Number(typed.temperature_f),
          timestamp: typed.created_at,
        }
      })

      setFreezerTrendPoints(points)
      setIsFreezerTrendLoading(false)
    }

    void loadFreezerTrend()

    return () => {
      isActive = false
    }
  }, [isFreezerSheetOpen, selectedFreezer, freezerRange, freezerCustomStart, freezerCustomEnd])

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
      if (!fenceConnection.online) return 'Offline'
      if (fenceContactor === 'STUCK ON') return 'Stuck On'
      if (fenceContactor === 'FAILED')   return 'Fault'
      return overview.fenceLine.chargerPower === 'ON' ? 'Secure' : 'Charger Off'
    })()

    const all = [
      hasFence || !isSupabaseConfigured ? {
        icon: 'fence' as StatusCardIcon,
        label: 'Fence',
        status: `State: ${fenceStatus}`,
        detail: `Connection: ${fenceConnection.label} · Contactor: ${fenceContactor}`,
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

  function openFreezerSheet(deviceId?: string) {
    const freezer = deviceId
      ? devices.find((device) => device.id === deviceId && device.type === 'freezer')
      : devices.find((device) => device.type === 'freezer')
    if (!freezer) return
    setSelectedFreezerId(freezer.id)
    setFreezerRange('24h')
    setFreezerCustomStart('')
    setFreezerCustomEnd('')
    setIsFreezerSheetOpen(true)
  }

  function freezerStatusLabel(device: DashboardDevice | null): 'Normal' | 'Warning' | 'Alarm' | 'Offline' {
    if (!device) return 'Offline'
    const connection = getDeviceOnlineStatus(device)
    if (!connection.online) return 'Offline'
    if (device.status === 'critical') return 'Alarm'
    if (device.status === 'warning') return 'Warning'
    return 'Normal'
  }

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

  function lifecycleProgressMessage(status: string, target: 'ON' | 'OFF') {
    if (status === 'pending') return 'Sending command...'
    if (status === 'gateway_received') return 'Command sent'
    if (status === 'sent_to_node') return 'Waiting for confirmation...'
    if (status === 'node_acknowledged') return `Field Lynk acknowledged ${target}`
    if (status === 'verified') return `Aux contact confirmed ${target}`
    if (status === 'verification_failed' || status === 'failed') return 'Failed to confirm, please check device status.'
    return 'Waiting for command...'
  }

  function triggerCommandFeedback() {
    try {
      if ('vibrate' in navigator) {
        navigator.vibrate([60, 40, 60])
      }
    } catch (error) {
      console.warn('Vibration feedback unavailable', error)
    }

    try {
      const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioContextClass) return

      const ctx = new AudioContextClass()
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()

      oscillator.type = 'sine'
      oscillator.frequency.value = 880
      gain.gain.setValueAtTime(0.0001, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16)

      oscillator.connect(gain)
      gain.connect(ctx.destination)

      oscillator.start()
      oscillator.stop(ctx.currentTime + 0.18)
      oscillator.onended = () => {
        void ctx.close()
      }
    } catch (error) {
      console.warn('Audio feedback unavailable', error)
    }
  }

  function mapCommandRowToRecord(row: Record<string, unknown>): CommandRecord {
    const rawCmd = String(row.command ?? row.command_type ?? '').toLowerCase()
    const mappedType: CommandRecord['command_type'] =
      rawCmd === 'turn_on' ? 'FENCE_TURN_ON'
      : rawCmd === 'turn_off' ? 'FENCE_TURN_OFF'
      : rawCmd === 'fence_turn_on' ? 'FENCE_TURN_ON'
      : rawCmd === 'fence_turn_off' ? 'FENCE_TURN_OFF'
      : 'FENCE_TEST_RELAY'

    return {
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
  }

  async function reconcileTimedOutFenceCommand(deviceId: string, clientCommandId: string, target: 'ON' | 'OFF') {
    if (!supabase) return

    // Slow mobile links can exceed the 8 s send timeout even when the insert eventually succeeds.
    for (let attempt = 0; attempt < 10; attempt++) {
      const { data, error } = await supabase
        .from('device_commands')
        .select('id, device_id, command, command_type, payload, status, created_at, sent_at, acknowledged_at, confirmed_at, failure_reason, client_command_id')
        .eq('device_id', deviceId)
        .eq('client_command_id', clientCommandId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!error && data) {
        const recovered = mapCommandRowToRecord(data as Record<string, unknown>)
        setBanner({ tone: 'warning', message: 'Slow connection detected. Command was queued; waiting for gateway...' })
        startFenceCommandTracking(recovered, target)
        return
      }

      await new Promise((resolve) => window.setTimeout(resolve, 2000))
    }
  }

  function startFenceCommandTracking(command: CommandRecord, target: 'ON' | 'OFF') {
    clearCommandDeliveryTracking()
    setLatestCommand(command)
    setBanner(lifecycleMessage(command.status, target))
    setFenceCommandProgress(lifecycleProgressMessage(command.status, target))

    const statusSeen = new Set<string>([command.status])

    const t8 = window.setTimeout(() => {
      if (!statusSeen.has('gateway_received')) {
        setBanner({ tone: 'warning', message: 'Command queued, but gateway has not picked it up yet.' })
      }
    }, 8_000)
    const t16 = window.setTimeout(() => {
      if (!statusSeen.has('node_acknowledged')) {
        setBanner({ tone: 'warning', message: 'Gateway did not receive confirmation from Field Lynk.' })
      }
    }, 16_000)
    const t24 = window.setTimeout(() => {
      if (!statusSeen.has('verified')) {
        setBanner({ tone: 'danger', message: 'Command not physically verified. Please check device status.' })
      }
    }, 24_000)
    const tPoll = window.setInterval(async () => {
      if (!supabase) return
      const { data, error } = await supabase
        .from('device_commands')
        .select('id, device_id, command, command_type, payload, status, created_at, sent_at, acknowledged_at, confirmed_at, failure_reason')
        .eq('id', command.id)
        .maybeSingle()
      if (error || !data) return

      const next = mapCommandRowToRecord(data as Record<string, unknown>)

      statusSeen.add(next.status)
      setLatestCommand(next)
      setBanner(lifecycleMessage(next.status, target))
      setFenceCommandProgress(lifecycleProgressMessage(next.status, target))
      if (next.status === 'verified') {
        setLastSuccessfulCommandAt(new Date().toISOString())
        setIsFenceCommandSending(false)
        clearCommandDeliveryTracking()
      }
      if (next.status === 'verification_failed' || next.status === 'failed') {
        setIsFenceCommandSending(false)
        clearCommandDeliveryTracking()
      }
    }, 2000)

    commandTimeoutTimersRef.current = [t8, t16, t24, tPoll]

    commandStatusUnsubRef.current = subscribeToCommandStatus(command.id, (next) => {
      statusSeen.add(next.status)
      setLatestCommand(next)
      setBanner(lifecycleMessage(next.status, target))
      setFenceCommandProgress(lifecycleProgressMessage(next.status, target))
      if (next.status === 'verified') {
        setLastSuccessfulCommandAt(new Date().toISOString())
        setIsFenceCommandSending(false)
        clearCommandDeliveryTracking()
      }
      if (next.status === 'verification_failed' || next.status === 'failed') {
        setIsFenceCommandSending(false)
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

  async function sendFenceCommand(commandType: 'FENCE_TURN_ON' | 'FENCE_TURN_OFF') {
    const fence = devices.find((d) => d.type === 'fence')
    if (!fence) return

    const target = commandType === 'FENCE_TURN_ON' ? 'ON' : 'OFF'

    if (!navigator.onLine) {
      setBanner({ tone: 'danger', message: 'No phone internet connection. Command was not sent.' })
      setFenceCommandProgress('No phone internet connection. Command was not sent.')
      return
    }

    setIsFenceCommandSending(true)
    setFenceCommandProgress('Sending command...')

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
      if (error === 'timeout') {
        setBanner({ tone: 'danger', message: 'Command not sent. Poor connection or server unreachable.' })
        setFenceCommandProgress('Command not sent. Poor connection or server unreachable.')
        setIsFenceCommandSending(false)
        void reconcileTimedOutFenceCommand(fence.id, clientCommandId, target)
        return
      }

      if (error || !command) {
        setBanner({ tone: 'danger', message: 'Command not sent. Poor connection or server unreachable.' })
        setFenceCommandProgress('Command not sent. Poor connection or server unreachable.')
        setIsFenceCommandSending(false)
        return
      }

      triggerCommandFeedback()
      setBanner({ tone: 'info', message: 'Command queued. Waiting for gateway...' })
      startFenceCommandTracking(command, target)
    } else {
      await createCommand({ target_device_id: fence.id, command_type: commandType, payload: {}, requested_by: 'home-tablet' })
      triggerCommandFeedback()
      setBanner({ tone: 'info', message: `${target} command sent.` })
      setFenceCommandProgress('Command sent')
      setIsFenceCommandSending(false)
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
  const freezerDevices = devices
    .filter((d) => d.type === 'freezer' && d.enabled !== false)
    .sort((a, b) => a.name.localeCompare(b.name))
  const gatewayDevice = devices.find((d) => d.type === 'gateway')
  const fieldNodeDevice = devices.find((d) => d.type === 'fence')
  const freezerDevice = selectedFreezer ?? devices.find((d) => d.type === 'freezer') ?? null
  const gatewaySeen = gatewayDevice?.last_seen
    ? `${new Date(gatewayDevice.last_seen).toLocaleTimeString()} (${getDeviceOnlineStatus(gatewayDevice).label})`
    : 'Unknown'
  const fieldSeen = fieldNodeDevice?.last_seen
    ? `${new Date(fieldNodeDevice.last_seen).toLocaleTimeString()} (${getDeviceOnlineStatus(fieldNodeDevice).label})`
    : 'Unknown'
  const fieldCardState = overview.fenceLine.chargerPower === 'ON' ? 'SECURE / ON' : 'OFF (Manual)'
  const freezerConnection = freezerDevice
    ? getDeviceOnlineStatus(freezerDevice).label
    : 'OFFLINE'
  const freezerCurrentTemp = (() => {
    if (!freezerDevice) return '--'
    const existing = String(freezerDevice.metadata.temperature ?? '').trim()
    if (existing) return existing
    const numeric = asNumber(freezerDevice.metadata.temperature_f)
    return numeric === null ? '--' : `${numeric.toFixed(1)}F`
  })()
  const freezerBattery = (() => {
    if (!freezerDevice) return 'n/a'
    const pct = asNumber(freezerDevice.metadata.battery_percent)
    if (pct !== null) return `${pct.toFixed(0)}%`
    const volts = asNumber(freezerDevice.metadata.battery_voltage)
    return volts !== null ? `${volts.toFixed(2)}V` : 'n/a'
  })()
  const freezerLastReport = freezerDevice?.metadata.updated
    ? new Date(String(freezerDevice.metadata.updated)).toLocaleString()
    : (freezerDevice?.last_seen ? new Date(freezerDevice.last_seen).toLocaleString() : 'Unknown')
  const freezerConnectionType = freezerDevice
    ? String(freezerDevice.metadata.connection_type ?? freezerDevice.metadata.network_type ?? freezerDevice.metadata.transport ?? 'Unknown')
    : 'Unknown'
  const freezerWarningF = asNumber(freezerDevice?.metadata.warning_high_f) ?? 5
  const freezerAlarmF = asNumber(freezerDevice?.metadata.alarm_high_f) ?? 10

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
            onClick={
              card.label === 'Fence'
                ? () => setIsFieldSheetOpen(true)
                : card.label === 'Freezer'
                  ? () => openFreezerSheet()
                  : undefined
            }
          />
        ))}
      </section>

      {freezerDevices.length > 0 && (
        <section className="panel page-section settings-section">
          <div className="settings-section__header">
            <div>
              <p className="eyebrow">Freezer Fleet</p>
              <h2>Freezer Lynks</h2>
            </div>
            <StatusPill tone="info">{freezerDevices.length} device{freezerDevices.length === 1 ? '' : 's'}</StatusPill>
          </div>

          <div className="device-summary-grid">
            {freezerDevices.map((device) => {
              const tone = deviceStatusTone(device.status)
              const connection = getDeviceOnlineStatus(device)
              const lastSeen = device.last_seen
                ? new Date(device.last_seen).toLocaleTimeString()
                : 'Unknown'

              return (
                <button
                  key={device.id}
                  type="button"
                  className={`device-tile device-tile--${tone}`}
                  onClick={() => openFreezerSheet(device.id)}
                >
                  <div className="device-tile__head">
                    <span className="device-tile__icon-wrap">
                      <Snowflake size={14} aria-hidden="true" />
                    </span>
                    <span className="device-tile__name">{device.name}</span>
                    <StatusPill tone={tone}>{device.status}</StatusPill>
                  </div>
                  {device.location && <p className="device-tile__location">{device.location}</p>}
                  <p className="device-tile__metric">{getKeyMetric(device)}</p>
                  <p className="device-tile__location">Last seen {lastSeen} ({connection.label})</p>
                  {Array.isArray(device.metadata.trend_points) && device.metadata.trend_points.length > 1 && (
                    <div className="device-tile__sparkline" aria-hidden="true">
                      <svg viewBox="0 0 120 28" preserveAspectRatio="none">
                        <path d={sparklinePath(device.metadata.trend_points as number[])} />
                      </svg>
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </section>
      )}

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
                onClick={() => {
                  if (device.type === 'freezer') {
                    openFreezerSheet(device.id)
                    return
                  }
                  void navigate(`/devices/${device.id}`)
                }}
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

      <FieldLynkControlSheet
        open={isFieldSheetOpen}
        deviceName="Field Lynk"
        currentState={fieldCardState}
        connectionStatus={fieldNodeDevice ? getDeviceOnlineStatus(fieldNodeDevice).label : 'OFFLINE'}
        auxFeedback={String(fieldNodeDevice?.metadata.contactor_feedback ?? 'Unknown')}
        lastUpdate={fieldNodeDevice?.last_seen ? new Date(fieldNodeDevice.last_seen).toLocaleString() : 'Unknown'}
        signalStrength={String(fieldNodeDevice?.metadata.rssi ?? 'n/a')}
        commandProgress={fenceCommandProgress}
        sending={isFenceCommandSending}
        onClose={() => setIsFieldSheetOpen(false)}
        onOpenSettings={() => {
          setIsFieldSheetOpen(false)
          void navigate('/settings')
        }}
        onHoldTurnOn={() => sendFenceCommand('FENCE_TURN_ON')}
        onHoldTurnOff={() => sendFenceCommand('FENCE_TURN_OFF')}
      />

      <FreezerQuickDetailSheet
        open={isFreezerSheetOpen}
        deviceName={freezerDevice?.name ?? 'Freezer Lynk'}
        currentTempLabel={freezerCurrentTemp}
        statusLabel={freezerStatusLabel(freezerDevice)}
        lastReportLabel={freezerLastReport}
        batteryLabel={freezerBattery}
        connectionLabel={freezerConnection}
        connectionTypeLabel={freezerConnectionType}
        range={freezerRange}
        customStart={freezerCustomStart}
        customEnd={freezerCustomEnd}
        warningThresholdF={freezerWarningF}
        alarmThresholdF={freezerAlarmF}
        points={freezerTrendPoints}
        loading={isFreezerTrendLoading}
        onClose={() => setIsFreezerSheetOpen(false)}
        onRangeChange={setFreezerRange}
        onCustomStartChange={setFreezerCustomStart}
        onCustomEndChange={setFreezerCustomEnd}
        onOpenSettings={() => {
          setIsFreezerSheetOpen(false)
          if (!freezerDevice) return
          void navigate(`/devices/${freezerDevice.id}`)
        }}
        onViewFullHistory={() => {
          setIsFreezerSheetOpen(false)
          if (!freezerDevice) return
          void navigate(`/devices/${freezerDevice.id}#history`)
        }}
      />
    </section>
  )
}
