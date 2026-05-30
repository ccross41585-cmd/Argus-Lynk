import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertsPanel } from '../components/dashboard/AlertsPanel'
import { DashboardHeader } from '../components/dashboard/DashboardHeader'
import { DrivewayAlarmCard } from '../components/dashboard/DrivewayAlarmCard'
import { FenceControllerCard } from '../components/dashboard/FenceControllerCard'
import { FreezerCard } from '../components/dashboard/FreezerCard'
import { LongRunAlertModal } from '../components/dashboard/LongRunAlertModal'
import { QuickActionsPanel } from '../components/dashboard/QuickActionsPanel'
import { StatusCard, type StatusCardIcon } from '../components/dashboard/StatusCard'
import { CONDITION_ICON } from '../components/dashboard/WeatherCard'
import { WeatherCard } from '../components/dashboard/WeatherCard'
import { WellPumpCard } from '../components/dashboard/WellPumpCard'
import {
  acknowledgeAlert,
  createCommand,
  getAlerts,
  getDashboardStatus,
  getDevices,
  silenceAlert,
} from '../lib/dashboardMock'
import { supabase } from '../lib/supabase'
import { loadUserProfile } from '../lib/userProfile'
import { fetchWeather, type LiveWeather } from '../lib/weather'
import type { AlertRecord, CommandRecord, DashboardDevice, DashboardOverview, DashboardTone } from '../types/dashboard'

const mockShutoffWillConfirm = true

type ModalPhase = 'question' | 'extended' | 'silenced' | 'awaiting-confirmation' | 'confirmed' | 'failed'

type BannerState = {
  tone: DashboardTone
  message: string
}

function formatClock(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(value)
}

function formatUpdatedAt(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function cardTone(status: string): DashboardTone {
  if (status === 'critical' || status === 'Alert' || status === 'Offline' || status === 'Node Offline') {
    return 'danger'
  }

  if (status === 'warning' || status === 'Warning' || status === 'Long Run Alert') {
    return 'warning'
  }

  if (status === 'Motion Detected' || status === 'Normal') {
    return 'info'
  }

  return 'success'
}

export function DashboardPage() {
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

  // Live weather from Open-Meteo using stored user profile coords
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
      } catch {
        // silent — falls back to mock weather text
      }
    }

    void loadWeather()
    // Refresh every 15 minutes
    const weatherInterval = window.setInterval(() => { void loadWeather() }, 15 * 60 * 1000)

    return () => {
      isActive = false
      window.clearInterval(weatherInterval)
    }
  }, [])

  useEffect(() => {
    document.title = 'Argus Lynk | Home Overview'
  }, [])

  useEffect(() => {
    const clockId = window.setInterval(() => {
      setCurrentTime(new Date())
    }, 1000)

    return () => {
      window.clearInterval(clockId)
    }
  }, [])

  useEffect(() => {
    let isActive = true

    async function loadDashboard() {
      const [nextOverview, nextDevices, nextAlerts] = await Promise.all([
        getDashboardStatus(),
        getDevices(),
        getAlerts(),
      ])

      if (!isActive) {
        return
      }

      setOverview(nextOverview)
      setDevices(nextDevices)
      setAlerts(nextAlerts)
      setIsLoading(false)
    }

    void loadDashboard()

    return () => {
      isActive = false
      timersRef.current.forEach((timer) => window.clearTimeout(timer))
    }
  }, [])

  const activeAlerts = useMemo(() => alerts.filter((alert) => !alert.resolved_at), [alerts])

  const nodesOnlineText = useMemo(() => {
    const onlineCount = devices.filter((device) => device.status !== 'offline' && device.status !== 'critical').length
    return `${onlineCount}/${devices.length}`
  }, [devices])

  const summaryCards = useMemo(() => {
    if (!overview) {
      return []
    }

    return [
      {
        icon: 'fence' as StatusCardIcon,
        label: 'Fence Status',
        status: overview.fenceLine.chargerPower === 'ON' ? 'Secure' : 'Off',
        detail: overview.fenceLine.feedback,
        tone: overview.fenceLine.chargerPower === 'ON' ? ('success' as const) : ('neutral' as const),
      },
      {
        icon: 'pump' as StatusCardIcon,
        label: 'Well Pump',
        status: overview.wellPump.pumpPower === 'ON' ? 'Running' : 'Off',
        detail: `${overview.wellPump.runtime} runtime`,
        tone: overview.wellPump.alertState === 'Long Run Alert' ? ('warning' as const) : ('info' as const),
      },
      {
        icon: 'freezer' as StatusCardIcon,
        label: 'Freezer',
        status: overview.freezer.temperature,
        detail: overview.freezer.state,
        tone: 'info' as const,
      },
      {
        icon: 'driveway' as StatusCardIcon,
        label: 'Driveway Alarm',
        status: overview.drivewayAlarm.status === 'Clear' ? 'Clear' : 'Alert',
        detail: `Last triggered ${overview.drivewayAlarm.lastTriggered}`,
        tone: cardTone(overview.drivewayAlarm.status),
      },
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
        label: 'Nodes Online',
        status: nodesOnlineText,
        detail: 'All field nodes reporting in.',
        tone: 'success' as const,
      },
    ]
  }, [nodesOnlineText, overview, liveWeather])

  function clearCommandTimers() {
    timersRef.current.forEach((timer) => window.clearTimeout(timer))
    timersRef.current = []
  }

  function setWellPumpResolved() {
    const now = new Date().toISOString()

    setDevices((currentDevices) =>
      currentDevices.map((device) => {
        if (device.type !== 'well_pump') {
          return device
        }

        return {
          ...device,
          status: 'online',
          last_seen: now,
          metadata: {
            ...device.metadata,
            runtime: '00 min 00 sec',
            relay_feedback: 'OFF',
            alert_state: 'Normal',
          },
        }
      }),
    )

    setAlerts((currentAlerts) =>
      currentAlerts.map((alert) => {
        if (alert.type !== 'well_pump_long_runtime' || alert.resolved_at) {
          return alert
        }

        return {
          ...alert,
          acknowledged: true,
          resolved_at: now,
        }
      }),
    )

    setOverview((current) =>
      current
        ? {
            ...current,
            lastUpdated: now,
            wellPump: {
              ...current.wellPump,
              pumpPower: 'OFF',
              runtime: '00 min 00 sec',
              feedback: 'Contactor confirmed OFF',
              alertState: 'Normal',
            },
            system: {
              ...current.system,
              awaitingConfirmations: 0,
              queueDepth: 1,
              lastCommand: 'Well pump shutoff confirmed by field feedback.',
            },
          }
        : current,
    )
  }

  async function openLongRunWorkflow() {
    setModalPhase('question')
    setCommandTimeline([])
    setModalOpen(true)
  }

  async function handleExtendRuntime() {
    const pumpDevice = devices.find((device) => device.type === 'well_pump')
    if (!pumpDevice) {
      return
    }

    const command = await createCommand({
      target_device_id: pumpDevice.id,
      command_type: 'WELL_PUMP_EXTEND_RUNTIME',
      payload: { minutes: 45 },
      requested_by: 'home-tablet',
    })

    setLatestCommand(command)
    setModalPhase('extended')
    setBanner({
      tone: 'info',
      message: 'Operator marked water usage as expected. Runtime alert timer was extended.',
    })
  }

  async function handleSilenceAlert() {
    const longRunAlert = alerts.find((alert) => alert.type === 'well_pump_long_runtime' && !alert.resolved_at)
    if (!longRunAlert) {
      return
    }

    await silenceAlert(longRunAlert.id)
    setAlerts((currentAlerts) =>
      currentAlerts.map((alert) =>
        alert.id === longRunAlert.id
          ? { ...alert, silenced_until: new Date(Date.now() + 30 * 60_000).toISOString() }
          : alert,
      ),
    )
    setModalPhase('silenced')
    setBanner({ tone: 'warning', message: 'Long-run alert silenced for 30 minutes. Pump remains active.' })
  }

  async function handleWellPumpShutoff() {
    const pumpDevice = devices.find((device) => device.type === 'well_pump')
    if (!pumpDevice) {
      return
    }

    clearCommandTimers()

    const pendingCommand = await createCommand({
      target_device_id: pumpDevice.id,
      command_type: 'WELL_PUMP_SHUTOFF',
      payload: { requested_state: 'OFF' },
      requested_by: 'home-tablet',
    })

    setLatestCommand(pendingCommand)
    setModalPhase('awaiting-confirmation')
    setCommandTimeline([])
    setBanner({ tone: 'warning', message: 'Shutdown command sent. Waiting for field node confirmation...' })

    const sentTimer = window.setTimeout(() => {
      setLatestCommand((current) =>
        current
          ? {
              ...current,
              status: 'sent',
              sent_at: new Date().toISOString(),
            }
          : current,
      )
      setCommandTimeline(['Command received'])
    }, 1000)

    const acknowledgedTimer = window.setTimeout(() => {
      setLatestCommand((current) =>
        current
          ? {
              ...current,
              status: 'acknowledged',
              acknowledged_at: new Date().toISOString(),
            }
          : current,
      )
      setCommandTimeline(['Command received', 'Relay/contact feedback confirmed OFF'])
    }, 2200)

    const finalizeTimer = window.setTimeout(() => {
      if (mockShutoffWillConfirm) {
        setLatestCommand((current) =>
          current
            ? {
                ...current,
                status: 'confirmed',
                confirmed_at: new Date().toISOString(),
              }
            : current,
        )
        setCommandTimeline([
          'Command received',
          'Relay/contact feedback confirmed OFF',
          'Pump power disabled',
        ])
        setModalPhase('confirmed')
        setBanner({ tone: 'success', message: 'Well pump shutdown confirmed by field feedback.' })
        setWellPumpResolved()
        return
      }

      setLatestCommand((current) =>
        current
          ? {
              ...current,
              status: 'failed',
              failure_reason: 'Field confirmation timeout',
            }
          : current,
      )
      setModalPhase('failed')
      setBanner({ tone: 'danger', message: 'Command sent, but shutdown confirmation was not received.' })
    }, 3600)

    timersRef.current = [sentTimer, acknowledgedTimer, finalizeTimer]
  }

  async function handleRestartWellPump() {
    const pumpDevice = devices.find((device) => device.type === 'well_pump')
    if (!pumpDevice) {
      return
    }

    const command = await createCommand({
      target_device_id: pumpDevice.id,
      command_type: 'WELL_PUMP_RESTART',
      payload: { requested_state: 'ON' },
      requested_by: 'home-tablet',
    })

    setLatestCommand(command)
    setBanner({ tone: 'info', message: 'Well pump restart command queued for the home base gateway.' })
  }

  async function handleFenceCommand(commandType: 'FENCE_TURN_ON' | 'FENCE_TURN_OFF' | 'FENCE_TEST_RELAY') {
    const fenceDevice = devices.find((device) => device.type === 'fence')
    if (!fenceDevice) {
      return
    }

    const command = await createCommand({
      target_device_id: fenceDevice.id,
      command_type: commandType,
      payload: {
        requested_state:
          commandType === 'FENCE_TEST_RELAY' ? 'TEST' : commandType === 'FENCE_TURN_ON' ? 'ON' : 'OFF',
      },
      requested_by: 'home-tablet',
    })

    setLatestCommand(command)
    setOverview((current) =>
      current
        ? {
            ...current,
            fenceLine: {
              ...current.fenceLine,
              lastCommand:
                commandType === 'FENCE_TEST_RELAY' ? 'TEST' : commandType === 'FENCE_TURN_ON' ? 'ON' : 'OFF',
            },
          }
        : current,
    )
    setBanner({ tone: 'info', message: 'Fence controller command queued. Waiting for gateway routing and node feedback.' })
  }

  async function handleAcknowledgeAlert(alertId: string) {
    await acknowledgeAlert(alertId)
    setAlerts((currentAlerts) =>
      currentAlerts.map((alert) => (alert.id === alertId ? { ...alert, acknowledged: true } : alert)),
    )
    setBanner({ tone: 'info', message: 'Alert acknowledged for operator review.' })
  }

  if (isLoading || !overview) {
    return (
      <section className="dashboard-page">
        <section className="dashboard-panel loading-panel">
          <p className="eyebrow">Loading</p>
          <h2>Building home overview</h2>
          <p className="section-copy">Fetching mock gateway, field node, and alert data.</p>
        </section>
      </section>
    )
  }

  return (
    <section className="dashboard-page" id="home">
      <DashboardHeader
        title={overview.title}
        gatewayStatus={overview.gatewayStatus}
        networkStrength={overview.networkStrength}
        currentTime={formatClock(currentTime)}
      />

      {banner && <div className={`alert alert--${banner.tone}`}>{banner.message}</div>}

      <section className="status-card-grid">
        {summaryCards.map((card) => (
          <StatusCard key={card.label} {...card} />
        ))}
      </section>

      <section className="content-grid">
        {/* Left column: primary controls */}
        <div className="content-col content-col--main">
          <WellPumpCard
            pumpPower={overview.wellPump.pumpPower}
            runtime={overview.wellPump.runtime}
            fieldNode={overview.wellPump.fieldNode}
            feedback={overview.wellPump.feedback}
            alertState={overview.wellPump.alertState}
            latestCommand={latestCommand}
            onShutOff={() => void openLongRunWorkflow()}
            onRestart={() => void handleRestartWellPump()}
            onViewDetails={() => setBanner({ tone: 'info', message: 'Pump detail drill-down can connect to live node history next.' })}
          />

          <div className="secondary-row">
            <FreezerCard
              temperature={overview.freezer.temperature}
              safeRange={overview.freezer.safeRange}
              node={overview.freezer.node}
              lastUpdated={overview.freezer.lastUpdatedLabel}
              alertState={overview.freezer.state}
              onViewDetails={() => setBanner({ tone: 'info', message: 'Freezer detail view is ready for live telemetry integration.' })}
            />

            <WeatherCard
              temperatureF={liveWeather?.temperatureF}
              temperatureText={overview.weather.temperature}
              summary={liveWeather?.summary ?? overview.weather.summary}
              condition={liveWeather?.condition}
              isDay={liveWeather?.isDay}
              windSpeedMph={liveWeather?.windSpeedMph}
              humidity={liveWeather?.humidity}
            />
          </div>
        </div>

        {/* Right column: field controls panel */}
        <aside className="field-controls-panel">
          <p className="eyebrow field-controls-panel__title">Field Controls</p>

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

          <div className="right-divider" />

          <DrivewayAlarmCard
            status={overview.drivewayAlarm.status}
            lastTriggered={overview.drivewayAlarm.lastTriggered}
            node={overview.drivewayAlarm.node}
          />

          <div className="right-divider" />

          <AlertsPanel
            alerts={activeAlerts}
            onOpenLongRunAlert={() => void openLongRunWorkflow()}
            onAcknowledge={(alertId) => void handleAcknowledgeAlert(alertId)}
          />

          <div className="right-divider" />

          <QuickActionsPanel
            queueDepth={overview.system.queueDepth}
            awaitingConfirmations={overview.system.awaitingConfirmations}
            lastCommand={latestCommand ? `${latestCommand.command_type} · ${latestCommand.status}` : overview.system.lastCommand}
            onSilenceAlerts={() => void handleSilenceAlert()}
            onViewSystemHealth={() => setBanner({ tone: 'info', message: `Last sync ${formatUpdatedAt(overview.lastUpdated)}.` })}
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