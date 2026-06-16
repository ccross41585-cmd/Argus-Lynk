import { useEffect, useRef, useState } from 'react'
import {
  Bell,
  BellOff,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Loader2,
  MapPin,
  Plus,
  Radio,
  Search,
  VolumeX,
  Wifi,
  WifiOff,
  XCircle,
} from 'lucide-react'
import {
  getNotificationPermission as _getNotificationPermission,
  isPushSupported,
  sendTestNotification,
  sendTestWellPumpAlert,
  subscribeToPushNotifications,
  unsubscribeFromPushNotifications,
  getCurrentPushSubscription,
} from '../services/pushNotifications'
import { StatusPill } from '../components/StatusPill'
import { maskProjectUrl } from '../lib/display'
import { isSupabaseConfigured, supabase, supabaseUrl, supabaseAnonKey } from '../lib/supabase'
import { geocodeLocation, type GeoResult } from '../lib/weather'
import { loadUserProfile, saveUserLocation } from '../lib/userProfile'
import { getLiveDevices } from '../lib/dashboardData'
import { getDashboardStatus, getDevices } from '../lib/dashboardMock'
import type { DashboardDevice } from '../types/dashboard'

// ─── Types ────────────────────────────────────────────────────────────────────

type SettingsPageProps = {
  localMode: boolean
  userId: string | null
  onSignOut: () => Promise<void>
}

type ConnectionState = 'checking' | 'connected' | 'error' | 'missing'

type WizardStep = 'closed' | 'type' | 'method' | 'detect' | 'configure' | 'done'
type DeviceTypeChoice = 'fence' | 'well_pump' | 'freezer' | 'driveway' | 'weather' | 'custom'
type PairingMethod = 'detect' | 'manual' | 'qr'

interface WizardState {
  step: WizardStep
  deviceType: DeviceTypeChoice | null
  pairingMethod: PairingMethod | null
  detectedNodeId: string
  deviceKey: string
  signalStrength: string
  displayName: string
  location: string
  wifiSsid: string
  wifiPassword: string
  updateChannel: 'stable' | 'beta'
  pairingPayload: string
  pairingError: string | null
  pinToHome: boolean
}

const WIZARD_INIT: WizardState = {
  step: 'closed',
  deviceType: null,
  pairingMethod: null,
  detectedNodeId: '',
  deviceKey: '',
  signalStrength: '',
  displayName: '',
  location: '',
  wifiSsid: '',
  wifiPassword: '',
  updateChannel: 'stable',
  pairingPayload: '',
  pairingError: null,
  pinToHome: false,
}

interface FreezerPairResponse {
  ok: boolean
  device?: { id: string; key: string; name: string }
  config?: {
    device_key: string
    telemetry_url: string
    telemetry_token: string
    supabase_anon_key: string
    firmware_manifest_url: string
    update_channel: string
  }
  error?: string
}

interface FreezerApStatusResponse {
  ok: boolean
  chip_id?: string
  device_key?: string
}

type FreezerPairSession = {
  device: { id: string; key: string; name: string }
  config: NonNullable<FreezerPairResponse['config']>
}

const DEVICE_TYPE_OPTIONS: { value: DeviceTypeChoice; label: string; abbr: string }[] = [
  { value: 'fence',     label: 'Fence Controller',      abbr: 'FEN' },
  { value: 'well_pump', label: 'Well Pump Controller',  abbr: 'PMP' },
  { value: 'freezer',   label: 'Freezer Lynk',          abbr: 'FRZ' },
  { value: 'driveway',  label: 'Driveway Alarm',        abbr: 'DRV' },
  { value: 'weather',   label: 'Weather Station',       abbr: 'WX' },
  { value: 'custom',    label: 'Custom Node',           abbr: 'CST' },
]

const UNCLAIMED_NODE = {
  nodeId: 'NODE-B2E9',
  type: 'Unknown (fence_controller?)',
  signal: '-68 dBm',
}

const DETECTED_NODE = {
  nodeId: 'NODE-A7F3',
  signal: '-72 dBm (Good)',
  battery: '4.1V',
  lastSeen: 'just now',
}

function toDbDeviceType(type: DeviceTypeChoice): string {
  switch (type) {
    case 'fence': return 'fence_controller'
    case 'well_pump': return 'pump_controller'
    case 'freezer': return 'freezer_lynk'
    case 'driveway': return 'driveway_alarm'
    case 'weather': return 'weather_station'
    default: return 'custom'
  }
}

function isMissingTenantColumnError(message: string | undefined): boolean {
  const text = String(message ?? '').toLowerCase()
  if (!text.includes('tenant_id')) return false
  return text.includes('does not exist') || text.includes('schema cache') || text.includes('could not find the')
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SettingsPage({ localMode, userId, onSignOut }: SettingsPageProps) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('checking')
  const [connectionMessage, setConnectionMessage] = useState('Checking cloud connection...')
  const [lastSync, setLastSync] = useState<string | null>(null)
  const [queueDepth, setQueueDepth] = useState<number | null>(null)

  // ── Push notification state ────────────────────────────────────────────────
  const [pushSupported] = useState(() => isPushSupported())
  const [pushPermission, setPushPermission] = useState<NotificationPermission>(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  )
  const [pushSubscribed, setPushSubscribed] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushMessage, setPushMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [lastTestSent, setLastTestSent] = useState<string | null>(null)

  useEffect(() => {
    void getCurrentPushSubscription().then((sub) => setPushSubscribed(Boolean(sub)))
  }, [])

  const [locationQuery, setLocationQuery] = useState('')
  const [geoResults, setGeoResults] = useState<GeoResult[]>([])
  const [geoSearching, setGeoSearching] = useState(false)
  const [geoError, setGeoError] = useState<string | null>(null)
  const [savedLocation, setSavedLocation] = useState<string | null>(null)
  const [locationSaving, setLocationSaving] = useState(false)
  const [locationSaveMsg, setLocationSaveMsg] = useState<string | null>(null)

  const [devices, setDevices] = useState<DashboardDevice[]>([])
  const [wizard, setWizard] = useState<WizardState>(WIZARD_INIT)
  const [freezerPairSession, setFreezerPairSession] = useState<FreezerPairSession | null>(null)
  const [freezerPairingBusy, setFreezerPairingBusy] = useState(false)
  const [freezerProvisionBusy, setFreezerProvisionBusy] = useState(false)
  const [showWifiPassword, setShowWifiPassword] = useState(false)
  const [freezerApChipId, setFreezerApChipId] = useState<string | null>(null)
  const [addedDevice, setAddedDevice] = useState<string | null>(null)
  const [detecting, setDetecting] = useState(false)
  const detectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Connection check ──────────────────────────────────────────────────────
  useEffect(() => {
    if (localMode) {
      setConnectionState('connected')
      setConnectionMessage('Running in local test mode. No cloud connection active.')
      setLastSync('N/A (local mode)')
      return
    }
    if (!isSupabaseConfigured || !supabase) {
      setConnectionState('missing')
      setConnectionMessage('Supabase environment variables are not configured.')
      setLastSync(null)
      return
    }
    supabase
      .from('devices')
      .select('id')
      .limit(1)
      .then(({ error }) => {
        if (error) {
          setConnectionState('error')
          setConnectionMessage(`Connection check failed: ${error.message}`)
        } else {
          setConnectionState('connected')
          setConnectionMessage('Cloud database is reachable.')
          setLastSync(new Date().toLocaleTimeString())
        }
      })
  }, [localMode])

  // ── Load profile ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!userId) return
    loadUserProfile(userId)
      .then((profile) => {
        if (profile?.location_label) setSavedLocation(profile.location_label)
      })
      .catch(() => { /* silent */ })
  }, [userId])

  // ── Load registered devices ───────────────────────────────────────────────
  useEffect(() => {
    if (localMode) {
      getDashboardStatus().then((status) => setQueueDepth(status.system.queueDepth))
      getDevices().then(setDevices)
      return
    }
    if (!isSupabaseConfigured) return
    void getLiveDevices().then(setDevices)
  }, [localMode])

  // ── Geocoding ─────────────────────────────────────────────────────────────
  async function handleGeoSearch() {
    const q = locationQuery.trim()
    if (!q) return
    setGeoSearching(true)
    setGeoError(null)
    setGeoResults([])
    try {
      const results = await geocodeLocation(q)
      if (results.length === 0) setGeoError('No locations found. Try "City, State" format.')
      else setGeoResults(results)
    } catch {
      setGeoError('Geocoding request failed. Check your connection.')
    } finally {
      setGeoSearching(false)
    }
  }

  async function handleSelectLocation(result: GeoResult) {
    if (!userId) {
      setLocationSaveMsg('Sign in required to save location.')
      return
    }
    setLocationSaving(true)
    setLocationSaveMsg(null)
    const { error } = await saveUserLocation(userId, {
      location_label: result.label,
      latitude: result.latitude,
      longitude: result.longitude,
      timezone: result.timezone,
    })
    setLocationSaving(false)
    if (error) {
      setLocationSaveMsg(`Save failed: ${error}`)
    } else {
      setSavedLocation(result.label)
      setGeoResults([])
      setLocationQuery('')
      setLocationSaveMsg('Location saved. Weather will update on next load.')
    }
  }

  // ── Wizard helpers ────────────────────────────────────────────────────────
  function startWizard(prefilledType?: DeviceTypeChoice) {
    setWizard({ ...WIZARD_INIT, step: prefilledType ? 'method' : 'type', deviceType: prefilledType ?? null })
    setFreezerPairSession(null)
    setFreezerPairingBusy(false)
    setFreezerProvisionBusy(false)
    setShowWifiPassword(false)
    setFreezerApChipId(null)
    setAddedDevice(null)
  }

  function wizardSetType(type: DeviceTypeChoice) {
    setWizard((w) => ({ ...w, step: 'method', deviceType: type }))
  }

  function wizardSetMethod(method: PairingMethod) {
    if (method === 'detect') {
      setWizard((w) => ({ ...w, step: 'detect', pairingMethod: method }))
      setDetecting(true)
      detectTimerRef.current = setTimeout(() => {
        setDetecting(false)
        setWizard((w) => ({
          ...w,
          step: 'configure',
          detectedNodeId: DETECTED_NODE.nodeId,
          deviceKey: DETECTED_NODE.nodeId.toLowerCase(),
          signalStrength: DETECTED_NODE.signal,
        }))
      }, 2000)
    } else {
      setWizard((w) => ({
        ...w,
        step: 'configure',
        pairingMethod: method,
        detectedNodeId: method === 'qr' ? DETECTED_NODE.nodeId : '',
        deviceKey: method === 'qr' ? DETECTED_NODE.nodeId.toLowerCase() : '',
        signalStrength: method === 'qr' ? DETECTED_NODE.signal : '',
      }))
    }
  }

  async function fetchFreezerApStatus(): Promise<FreezerApStatusResponse | null> {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 2500)
      const response = await fetch('http://192.168.4.1/status', {
        method: 'GET',
        mode: 'cors',
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (!response.ok) return null
      return await response.json() as FreezerApStatusResponse
    } catch {
      return null
    }
  }

  useEffect(() => {
    if (wizard.step !== 'configure' || wizard.deviceType !== 'freezer') {
      setFreezerApChipId(null)
      return
    }

    let cancelled = false
    void fetchFreezerApStatus().then((status) => {
      if (cancelled || !status?.chip_id) return
      const chip = status.chip_id.toUpperCase()
      setFreezerApChipId(chip)

      setWizard((w) => {
        const current = w.deviceKey.trim()
        const shouldAutofill = !current || /^node-/i.test(current)
        if (!shouldAutofill) return w
        return {
          ...w,
          deviceKey: `FL-${chip}`,
          detectedNodeId: w.detectedNodeId || chip,
          pairingError: null,
        }
      })
    })

    return () => {
      cancelled = true
    }
  }, [wizard.step, wizard.deviceType])

  async function pairFreezerDevice(overrides?: { deviceKey?: string | null; factoryId?: string | null }): Promise<FreezerPairResponse> {
    if (!supabase || !isSupabaseConfigured) return { ok: false, error: 'Supabase is not configured.' }

    const { data: sessionData } = await supabase.auth.getSession()
    const accessToken = sessionData.session?.access_token
    if (!accessToken) return { ok: false, error: 'You must be signed in to pair a freezer.' }

    const payload = {
      display_name: wizard.displayName.trim() || 'Freezer Lynk',
      location_label: wizard.location.trim() || savedLocation || null,
      update_channel: wizard.updateChannel,
      factory_id: (overrides?.factoryId ?? wizard.detectedNodeId.trim()) || null,
      device_key: (overrides?.deviceKey ?? wizard.deviceKey.trim()) || null,
    }

    try {
      const response = await fetch(`${supabaseUrl}/functions/v1/freezer-pair-device`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      })

      const body = await response.json().catch(() => ({})) as FreezerPairResponse
      if (!response.ok) {
        return { ok: false, error: body.error ?? `Pairing failed (${response.status})` }
      }

      return body
    } catch {
      return {
        ok: false,
        error: 'Cloud pairing is unreachable on current connection. If you are on FreezerLynk Wi-Fi with weak/no mobile data, use manual fallback and pair ownership once internet is restored.',
      }
    }
  }

  async function pushConfigToFreezerAp(configPayload: FreezerPairResponse['config']): Promise<{ ok: boolean; error?: string }> {
    if (!configPayload) return { ok: false, error: 'Missing pairing config payload.' }
    if (!wizard.wifiSsid.trim()) return { ok: false, error: 'Wi-Fi network name is required.' }

    const response = await fetch('http://192.168.4.1/configure', {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...configPayload,
        wifi_ssid: wizard.wifiSsid.trim(),
        wifi_password: wizard.wifiPassword,
        update_channel: wizard.updateChannel,
      }),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, error: text || `Provisioning failed (${response.status})` }
    }

    return { ok: true }
  }

  async function wizardSave() {
    const name = wizard.displayName.trim() || `${wizard.deviceType ?? 'Device'}-new`
    const dbType = toDbDeviceType(wizard.deviceType ?? 'custom')
    const manualDeviceKey = wizard.deviceKey.trim() || wizard.detectedNodeId.trim() || null

    if (dbType === 'freezer_lynk' && !localMode) return

    if (!localMode && supabase) {
      const defaultLocation = wizard.location.trim() || savedLocation || null
      const payload = {
        name,
        type: dbType,
        device_type: dbType,
        device_key: manualDeviceKey,
        location: defaultLocation,
        enabled: true,
        online: false,
        status: 'offline',
        metadata: {
          owner_user_id: userId,
          owner_location_label: defaultLocation,
        },
      }

      let insertData: { id: string } | null = null
      let insertError: { message: string } | null = null

      const ownerPayload = userId
        ? { ...payload, tenant_id: userId }
        : payload

      const firstInsert = await supabase
        .from('devices')
        .insert(ownerPayload)
        .select('id')
        .single()

      if (firstInsert.error && userId && isMissingTenantColumnError(firstInsert.error.message)) {
        const fallbackInsert = await supabase
          .from('devices')
          .insert(payload)
          .select('id')
          .single()
        insertData = fallbackInsert.data as { id: string } | null
        insertError = fallbackInsert.error ? { message: fallbackInsert.error.message } : null
      } else {
        insertData = firstInsert.data as { id: string } | null
        insertError = firstInsert.error ? { message: firstInsert.error.message } : null
      }

      if (insertError || !insertData) {
        setAddedDevice(`Failed to add device: ${insertError?.message ?? 'Unknown insert failure'}`)
        setWizard((w) => ({ ...w, step: 'done' }))
        return
      }

      if (dbType === 'freezer_lynk') {
        await supabase
          .from('freezer_lynk_settings')
          .upsert({ device_id: insertData.id })
      }

      const fresh = await getLiveDevices()
      setDevices(fresh)
    }

    setAddedDevice(name)
    setWizard({ ...WIZARD_INIT, step: 'done' })
  }

  async function freezerStep1PairCloud() {
    setFreezerPairingBusy(true)
    setWizard((w) => ({ ...w, pairingError: null }))

    const apStatus = await fetchFreezerApStatus()
    const apChip = apStatus?.chip_id?.toUpperCase() ?? null
    const resolvedDeviceKey = wizard.deviceKey.trim() || (apChip ? `FL-${apChip}` : null)
    const resolvedFactoryId = wizard.detectedNodeId.trim() || apChip || null

    if (resolvedDeviceKey && resolvedDeviceKey !== wizard.deviceKey) {
      setWizard((w) => ({ ...w, deviceKey: resolvedDeviceKey }))
    }

    const pairResult = await pairFreezerDevice({
      deviceKey: resolvedDeviceKey,
      factoryId: resolvedFactoryId,
    })

    if (!pairResult.ok || !pairResult.config || !pairResult.device) {
      const fallbackConfigBody = JSON.stringify({
        device_key: resolvedDeviceKey || `FL-${apChip ?? 'UNKNOWN'}`,
        telemetry_url: `${supabaseUrl}/functions/v1/freezer-telemetry`,
        telemetry_token: '',
        supabase_anon_key: supabaseAnonKey || '',
        firmware_manifest_url: `${supabaseUrl}/functions/v1/freezer-firmware-manifest`,
        update_channel: wizard.updateChannel,
        wifi_ssid: wizard.wifiSsid.trim(),
        wifi_password: wizard.wifiPassword,
      }, null, 2)

      setWizard((w) => ({
        ...w,
        pairingError: pairResult.error ?? 'Cloud pairing failed.',
        pairingPayload: fallbackConfigBody,
      }))
      setFreezerPairingBusy(false)
      return
    }

    const localProvisionBody = JSON.stringify({
      ...pairResult.config,
      wifi_ssid: wizard.wifiSsid.trim(),
      wifi_password: wizard.wifiPassword,
      update_channel: wizard.updateChannel,
    }, null, 2)

    setFreezerPairSession({
      device: pairResult.device,
      config: pairResult.config,
    })
    setWizard((w) => ({
      ...w,
      pairingError: null,
      pairingPayload: localProvisionBody,
      deviceKey: pairResult.device?.key ?? w.deviceKey,
    }))
    setFreezerPairingBusy(false)
  }

  async function freezerStep2SendLocalConfig() {
    if (!freezerPairSession?.config) {
      setWizard((w) => ({ ...w, pairingError: 'Run Step 1 (Cloud Pair) first.' }))
      return
    }

    setFreezerProvisionBusy(true)
    setWizard((w) => ({ ...w, pairingError: null }))

    const provisionResult = await pushConfigToFreezerAp(freezerPairSession.config)
    if (!provisionResult.ok) {
      setWizard((w) => ({
        ...w,
        pairingError: provisionResult.error ?? 'Unable to send config to freezer AP.',
      }))
      setFreezerProvisionBusy(false)
      return
    }

    setAddedDevice(`${freezerPairSession.device.name} paired and provisioned`)
    setWizard({ ...WIZARD_INIT, step: 'done' })
    setFreezerPairSession(null)
    setFreezerProvisionBusy(false)
    const fresh = await getLiveDevices()
    setDevices(fresh)
  }

  function wizardClose() {
    if (detectTimerRef.current) clearTimeout(detectTimerRef.current)
    setWizard(WIZARD_INIT)
    setFreezerPairSession(null)
    setFreezerPairingBusy(false)
    setFreezerProvisionBusy(false)
    setShowWifiPassword(false)
    setFreezerApChipId(null)
    setDetecting(false)
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const connTone =
    connectionState === 'connected' ? 'success'
    : connectionState === 'checking' ? 'warning'
    : 'danger'

  const connLabel =
    connectionState === 'connected' ? (localMode ? 'Local Mode' : 'Connected')
    : connectionState === 'checking' ? 'Checking...'
    : 'Offline'

  const queueHealth =
    queueDepth === null ? '—'
    : queueDepth === 0 ? 'Clear'
    : `${queueDepth} pending`

  const nonGatewayDevices = devices.filter((d) => d.type !== 'gateway')
  const wizardOpen = wizard.step !== 'closed' && wizard.step !== 'done'

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <section className="settings-page stack">

      {/* ─ Header ─────────────────────────────────────────────────────────── */}
      <header className="panel hero-card page-header">
        <p className="eyebrow">Settings</p>
        <h1>Account &amp; System</h1>
        <p className="section-copy">Manage your connection, location, and registered devices.</p>
      </header>

      {/* ─ Cloud Connection ───────────────────────────────────────────────── */}
      <section className="panel page-section settings-section">
        <div className="settings-section__header">
          <div>
            <p className="eyebrow">Network</p>
            <h2>Cloud Connection</h2>
          </div>
          {connectionState === 'connected'
            ? <Wifi size={20} style={{ color: 'var(--accent)' }} />
            : connectionState === 'checking'
              ? <Loader2 size={20} className="spin" />
              : <WifiOff size={20} style={{ color: '#e05c5c' }} />
          }
        </div>

        <div className="settings-connection-grid">
          <div className="settings-stat-row">
            <span className="label">Status</span>
            <StatusPill tone={connTone}>{connLabel}</StatusPill>
          </div>
          <div className="settings-stat-row">
            <span className="label">Last Sync</span>
            <span className="mono">{lastSync ?? '—'}</span>
          </div>
          <div className="settings-stat-row">
            <span className="label">Command Queue</span>
            <span className="mono">{queueHealth}</span>
          </div>
          <div className="settings-stat-row">
            <span className="label">Gateway Pairing</span>
            <StatusPill tone={localMode ? 'success' : 'warning'}>
              {localMode ? 'Paired (mock)' : 'Not Paired'}
            </StatusPill>
          </div>
          <div className="settings-stat-row settings-stat-row--last">
            <span className="label">Test Mode</span>
            <StatusPill tone={localMode ? 'warning' : 'success'}>
              {localMode ? 'Local Test Mode' : 'Live / Cloud'}
            </StatusPill>
          </div>
        </div>

        <button type="button" className="ghost-button" onClick={() => void onSignOut()}>
          {localMode ? 'Exit Local Mode' : 'Sign Out'}
        </button>
      </section>

      {/* ─ Notifications ──────────────────────────────────────────────────── */}
      <section className="panel page-section settings-section">
        <div className="settings-section__header">
          <div>
            <p className="eyebrow">Alerts</p>
            <h2>Notifications</h2>
          </div>
        </div>

        {!pushSupported ? (
          <div className="settings-stat-row">
            <span className="label">Push Notifications</span>
            <div>
              <StatusPill tone="neutral">Unsupported</StatusPill>
              <p className="muted-copy" style={{ marginTop: 6, fontSize: '0.8rem' }}>
                Push notifications are not supported in this browser or device.
                Try Chrome or Edge on desktop, or Chrome for Android.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="settings-stat-row">
              <span className="label">Push Notifications</span>
              <StatusPill
                tone={pushPermission === 'granted' && pushSubscribed ? 'success'
                  : pushPermission === 'denied' ? 'danger' : 'neutral'}
              >
                {pushPermission === 'granted' && pushSubscribed ? 'Enabled'
                  : pushPermission === 'denied' ? 'Blocked'
                  : pushPermission === 'granted' ? 'Not Subscribed'
                  : 'Disabled'}
              </StatusPill>
            </div>

            <div className="settings-stat-row">
              <span className="label">Permission</span>
              <span className="mono" style={{ fontSize: '0.85rem' }}>
                {pushPermission === 'granted' ? 'Granted'
                  : pushPermission === 'denied' ? 'Denied — change in browser site settings'
                  : 'Not yet requested'}
              </span>
            </div>

            {lastTestSent && (
              <div className="settings-stat-row">
                <span className="label">Last Test Sent</span>
                <span className="mono" style={{ fontSize: '0.85rem' }}>{lastTestSent}</span>
              </div>
            )}

            {pushMessage && (
              <div className={`alert alert--${pushMessage.type === 'success' ? 'success' : 'danger'}`}
                style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, fontSize: '0.85rem' }}>
                {pushMessage.text}
              </div>
            )}

            {pushPermission === 'denied' && (
              <p className="muted-copy" style={{ fontSize: '0.8rem', marginTop: 4 }}>
                Notifications are blocked for this site. To re-enable, click the lock icon
                in the browser address bar → Notifications → Allow, then refresh.
              </p>
            )}

            <div className="settings-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
              {(!pushSubscribed || pushPermission !== 'granted') && pushPermission !== 'denied' && (
                <button
                  type="button"
                  className="action-button"
                  disabled={pushBusy}
                  onClick={async () => {
                    if (!userId) { setPushMessage({ type: 'error', text: 'You must be signed in to enable push notifications.' }); return }
                    setPushBusy(true)
                    setPushMessage(null)
                    const { error } = await subscribeToPushNotifications(userId, 'default-tenant')
                    if (error) {
                      setPushMessage({ type: 'error', text: error })
                    } else {
                      setPushSubscribed(true)
                      setPushPermission('granted')
                      setPushMessage({ type: 'success', text: 'Push notifications enabled for this device.' })
                    }
                    setPushBusy(false)
                  }}
                >
                  {pushBusy ? <Loader2 size={14} className="spin" /> : <Bell size={14} />}
                  Enable Notifications
                </button>
              )}

              {pushSubscribed && pushPermission === 'granted' && (
                <>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={pushBusy}
                    onClick={async () => {
                      setPushBusy(true)
                      setPushMessage(null)
                      const { error } = await sendTestNotification()
                      if (error) {
                        setPushMessage({ type: 'error', text: error })
                      } else {
                        setLastTestSent(new Date().toLocaleTimeString())
                        setPushMessage({ type: 'success', text: 'Test notification sent.' })
                      }
                      setPushBusy(false)
                    }}
                  >
                    {pushBusy ? <Loader2 size={14} className="spin" /> : <Bell size={14} />}
                    Send Test Notification
                  </button>

                  <button
                    type="button"
                    className="ghost-button"
                    disabled={pushBusy}
                    onClick={async () => {
                      if (!userId) return
                      setPushBusy(true)
                      setPushMessage(null)
                      const { error } = await unsubscribeFromPushNotifications(userId)
                      if (error) {
                        setPushMessage({ type: 'error', text: error })
                      } else {
                        setPushSubscribed(false)
                        setPushMessage({ type: 'success', text: 'This device unsubscribed from notifications.' })
                      }
                      setPushBusy(false)
                    }}
                  >
                    <BellOff size={14} />
                    Disable This Device
                  </button>
                </>
              )}
            </div>

            {localMode && (
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 16, marginTop: 8 }}>
                <p className="eyebrow" style={{ marginBottom: 8 }}>Local Test Mode</p>
                <button
                  type="button"
                  className="ghost-button btn-sm"
                  disabled={pushBusy || pushPermission !== 'granted'}
                  onClick={async () => {
                    setPushBusy(true)
                    const { error } = await sendTestWellPumpAlert()
                    if (error) setPushMessage({ type: 'error', text: error })
                    else { setLastTestSent(new Date().toLocaleTimeString()); setPushMessage({ type: 'success', text: 'Well pump test alert sent.' }) }
                    setPushBusy(false)
                  }}
                >
                  <VolumeX size={14} />
                  Trigger Well Pump Alert
                </button>
                {pushPermission !== 'granted' && (
                  <p className="muted-copy" style={{ fontSize: '0.78rem', marginTop: 4 }}>
                    Enable notifications above before using test buttons.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* ─ Device Setup ───────────────────────────────────────────────────── */}
      <section className="panel page-section settings-section">
        <div className="settings-section__header">
          <div>
            <p className="eyebrow">Devices</p>
            <h2>Device Setup</h2>
          </div>
          {!wizardOpen ? (
            <button type="button" className="action-button" onClick={() => startWizard()}>
              <Plus size={15} />
              Add Device
            </button>
          ) : (
            <button type="button" className="ghost-button" onClick={wizardClose}>Cancel</button>
          )}
        </div>

        {/* Completion banner */}
        {wizard.step === 'done' && addedDevice && (
          <div className="alert alert--success" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CheckCircle2 size={16} />
            <span><strong>{addedDevice}</strong> added. Restart the app to see it in your device list.</span>
          </div>
        )}

        {/* Wizard panel */}
        {wizardOpen && (
          <div className="wizard-panel">

            {/* Step 1 — Select type */}
            {wizard.step === 'type' && (
              <>
                <div>
                  <p className="eyebrow">Step 1 of 4</p>
                  <h3 style={{ margin: 0 }}>Select Device Type</h3>
                </div>
                <div className="wizard-step-list">
                  {DEVICE_TYPE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`wizard-type-btn${wizard.deviceType === opt.value ? ' selected' : ''}`}
                      onClick={() => wizardSetType(opt.value)}
                    >
                      <span className="mono" style={{ fontSize: '0.7rem', color: 'var(--muted)', minWidth: 32 }}>{opt.abbr}</span>
                      <span>{opt.label}</span>
                    </button>
                  ))}
                </div>
                {wizard.deviceType && (
                  <button type="button" className="action-button" onClick={() => setWizard((w) => ({ ...w, step: 'method' }))}>
                    Continue
                  </button>
                )}
              </>
            )}

            {/* Step 2 — Choose pairing method */}
            {wizard.step === 'method' && (
              <>
                <div>
                  <p className="eyebrow">Step 2 of 4</p>
                  <h3 style={{ margin: 0 }}>Choose Pairing Method</h3>
                </div>
                <div className="wizard-step-list">
                  <button type="button" className="wizard-type-btn" onClick={() => wizardSetMethod('detect')}>
                    <Radio size={17} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                    <div>
                      <div>Detect Nearby Device</div>
                      <div className="label">Scans for unclaimed LoRa nodes in range</div>
                    </div>
                  </button>
                  <button type="button" className="wizard-type-btn" onClick={() => wizardSetMethod('manual')}>
                    <Cpu size={17} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                    <div>
                      <div>Enter Device ID Manually</div>
                      <div className="label">Type the node ID printed on the device</div>
                    </div>
                  </button>
                  <button type="button" className="wizard-type-btn" onClick={() => wizardSetMethod('qr')}>
                    <Search size={17} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                    <div>
                      <div>Pairing Code / QR Code</div>
                      <div className="label">Scan the QR code on the device label</div>
                    </div>
                  </button>
                </div>
              </>
            )}

            {/* Step 3 — Scanning */}
            {wizard.step === 'detect' && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '8px 0' }}>
                <Loader2 size={32} className="spin" style={{ color: 'var(--accent)' }} />
                <p className="section-copy" style={{ textAlign: 'center', margin: 0 }}>
                  Scanning for nearby unclaimed devices...
                </p>
                {detecting && <p className="label" style={{ margin: 0 }}>This may take a few seconds.</p>}
              </div>
            )}

            {/* Step 4 — Configure */}
            {wizard.step === 'configure' && (
              <>
                <div>
                  <p className="eyebrow">Step 3 of 4</p>
                  <h3 style={{ margin: 0 }}>Configure Device</h3>
                </div>

                {wizard.detectedNodeId && (
                  <div className="device-setup-row" style={{ fontSize: '0.82rem', gap: 16 }}>
                    <Radio size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                    <div style={{ display: 'grid', gap: 6, flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span className="label">Node ID</span>
                        <strong className="mono">{wizard.detectedNodeId}</strong>
                      </div>
                      {wizard.signalStrength && (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span className="label">Signal</span>
                          <strong className="mono">{wizard.signalStrength}</strong>
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span className="label">Battery</span>
                        <strong className="mono">{DETECTED_NODE.battery}</strong>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span className="label">Last Seen</span>
                        <strong className="mono">{DETECTED_NODE.lastSeen}</strong>
                      </div>
                    </div>
                  </div>
                )}

                {wizard.pairingMethod === 'manual' && (
                  <div style={{ display: 'grid', gap: 6 }}>
                    <label className="label" htmlFor="wizard-node-id">Device Node ID</label>
                    <input
                      id="wizard-node-id"
                      className="settings-location-input"
                      type="text"
                      placeholder="e.g. NODE-A7F3"
                      value={wizard.detectedNodeId}
                      onChange={(e) => setWizard((w) => ({ ...w, detectedNodeId: e.target.value }))}
                    />
                  </div>
                )}

                {wizard.deviceType === 'freezer' && (
                  <>
                    <div className="alert" style={{ padding: '10px 12px', borderRadius: 10, fontSize: '0.82rem' }}>
                      <strong>Two-step setup:</strong><br />
                      1) While online, run <strong>Step 1: Cloud Pair</strong>.<br />
                      2) Join <strong>FreezerLynk-XXXXXX</strong> Wi-Fi, then run <strong>Step 2: Send Local Config</strong>.
                    </div>

                    <div style={{ display: 'grid', gap: 6 }}>
                      <label className="label" htmlFor="wizard-device-key">Freezer Device Key (optional)</label>
                      <input
                        id="wizard-device-key"
                        className="settings-location-input"
                        type="text"
                        placeholder="Leave blank to auto-generate"
                        value={wizard.deviceKey}
                        onChange={(e) => setWizard((w) => ({ ...w, deviceKey: e.target.value, pairingError: null }))}
                      />
                    </div>

                    <div style={{ display: 'grid', gap: 6 }}>
                      <label className="label" htmlFor="wizard-freezer-wifi-ssid">Home Wi-Fi SSID</label>
                      <input
                        id="wizard-freezer-wifi-ssid"
                        className="settings-location-input"
                        type="text"
                        placeholder="e.g. MyFarmNetwork"
                        value={wizard.wifiSsid}
                        onChange={(e) => setWizard((w) => ({ ...w, wifiSsid: e.target.value, pairingError: null }))}
                      />
                    </div>

                    <div style={{ display: 'grid', gap: 6 }}>
                      <label className="label" htmlFor="wizard-freezer-wifi-pass">Home Wi-Fi Password</label>
                      <input
                        id="wizard-freezer-wifi-pass"
                        className="settings-location-input"
                        type={showWifiPassword ? 'text' : 'password'}
                        placeholder="Wi-Fi password"
                        value={wizard.wifiPassword}
                        onChange={(e) => setWizard((w) => ({ ...w, wifiPassword: e.target.value, pairingError: null }))}
                      />
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={showWifiPassword}
                          onChange={(e) => setShowWifiPassword(e.target.checked)}
                        />
                        <span className="label">Show password</span>
                      </label>
                    </div>

                    {freezerApChipId && (
                      <div className="alert" style={{ padding: '10px 12px', borderRadius: 10, fontSize: '0.82rem' }}>
                        Connected Freezer AP chip ID: <strong className="mono">{freezerApChipId}</strong>
                        {wizard.deviceKey.trim() && !wizard.deviceKey.toUpperCase().includes(freezerApChipId)
                          ? ' — Device key does not match AP chip ID. Consider using FL-' + freezerApChipId + ' to avoid confusion.'
                          : ''}
                      </div>
                    )}

                    <div style={{ display: 'grid', gap: 6 }}>
                      <label className="label" htmlFor="wizard-freezer-channel">Update Channel</label>
                      <select
                        id="wizard-freezer-channel"
                        className="settings-location-input"
                        value={wizard.updateChannel}
                        onChange={(e) => {
                          const value = e.target.value === 'beta' ? 'beta' : 'stable'
                          setWizard((w) => ({ ...w, updateChannel: value, pairingError: null }))
                        }}
                      >
                        <option value="stable">Stable</option>
                        <option value="beta">Beta</option>
                      </select>
                    </div>

                    {wizard.pairingError && (
                      <div className="alert alert--danger" style={{ fontSize: '0.82rem' }}>
                        {wizard.pairingError}
                      </div>
                    )}

                    {wizard.pairingPayload && (
                      <div style={{ display: 'grid', gap: 8 }}>
                        <p className="label" style={{ margin: 0 }}>
                          Manual fallback: while connected to the freezer AP, open
                          {' '}<strong>http://192.168.4.1</strong>{' '}
                          and enter these values in the on-device setup page.
                        </p>
                        <textarea
                          className="settings-location-input"
                          style={{ minHeight: 160, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: '0.76rem' }}
                          value={wizard.pairingPayload}
                          readOnly
                        />
                      </div>
                    )}

                    <div style={{ display: 'grid', gap: 8 }}>
                      <button
                        type="button"
                        className="action-button"
                        disabled={freezerPairingBusy || !wizard.wifiSsid.trim()}
                        onClick={() => void freezerStep1PairCloud()}
                      >
                        {freezerPairingBusy ? 'Pairing in Cloud…' : 'Step 1: Cloud Pair'}
                      </button>

                      <button
                        type="button"
                        className="action-button"
                        disabled={freezerProvisionBusy || !freezerPairSession || !wizard.wifiSsid.trim()}
                        onClick={() => void freezerStep2SendLocalConfig()}
                      >
                        {freezerProvisionBusy ? 'Sending to Freezer…' : 'Step 2: Send Local Config'}
                      </button>

                      <p className="label" style={{ margin: 0 }}>
                        Step 2 requires your phone to be connected to FreezerLynk Wi-Fi.
                        {freezerPairSession ? ` Cloud pair ready for ${freezerPairSession.device.key}.` : ' Run Step 1 first while online.'}
                      </p>
                    </div>
                  </>
                )}

                <div style={{ display: 'grid', gap: 6 }}>
                  <label className="label" htmlFor="wizard-display-name">Display Name</label>
                  <input
                    id="wizard-display-name"
                    className="settings-location-input"
                    type="text"
                    placeholder="e.g. North Fence"
                    value={wizard.displayName}
                    onChange={(e) => setWizard((w) => ({ ...w, displayName: e.target.value }))}
                  />
                </div>

                <div style={{ display: 'grid', gap: 6 }}>
                  <label className="label" htmlFor="wizard-device-location">Location</label>
                  <input
                    id="wizard-device-location"
                    className="settings-location-input"
                    type="text"
                    placeholder="e.g. Back Pasture"
                    value={wizard.location}
                    onChange={(e) => setWizard((w) => ({ ...w, location: e.target.value }))}
                  />
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={wizard.pinToHome}
                    onChange={(e) => setWizard((w) => ({ ...w, pinToHome: e.target.checked }))}
                  />
                  <span className="label">Pin to Home Overview</span>
                </label>

                {wizard.deviceType !== 'freezer' && (() => {
                  const missingName = !wizard.displayName.trim()
                  const isDisabled = missingName
                  const hint = missingName
                    ? 'Enter a display name to continue'
                    : null
                  return (
                    <>
                      {hint && (
                        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-text-muted, #888)' }}>
                          ⚠ {hint}
                        </p>
                      )}
                      <button
                        type="button"
                        className="action-button"
                        onClick={() => void wizardSave()}
                        disabled={isDisabled}
                      >
                        Save Device
                      </button>
                    </>
                  )
                })()}
              </>
            )}
          </div>
        )}

        {/* Unclaimed node banner */}
        {localMode && !wizardOpen && (
          <div>
            <p className="eyebrow" style={{ marginBottom: 8 }}>Unclaimed</p>
            <div className="unclaimed-banner">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Radio size={15} style={{ color: '#f0b45a' }} />
                <strong style={{ color: '#f0b45a' }}>New device found</strong>
              </div>
              <div style={{ display: 'grid', gap: 4, fontSize: '0.83rem' }}>
                <div className="settings-stat-row" style={{ padding: '5px 0' }}>
                  <span className="label">Node ID</span>
                  <span className="mono">{UNCLAIMED_NODE.nodeId}</span>
                </div>
                <div className="settings-stat-row" style={{ padding: '5px 0' }}>
                  <span className="label">Type</span>
                  <span className="mono">{UNCLAIMED_NODE.type}</span>
                </div>
                <div className="settings-stat-row settings-stat-row--last" style={{ padding: '5px 0' }}>
                  <span className="label">Signal</span>
                  <span className="mono">{UNCLAIMED_NODE.signal}</span>
                </div>
              </div>
              <button
                type="button"
                className="action-button"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => startWizard('fence')}
              >
                Claim Device
              </button>
            </div>
          </div>
        )}

        {/* Registered devices list */}
        {nonGatewayDevices.length > 0 && (
          <div>
            <p className="eyebrow" style={{ marginBottom: 8 }}>Registered</p>
            <div className="device-setup-list">
              {nonGatewayDevices.map((device) => (
                <div key={device.id} className="device-setup-row">
                  <Cpu size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.88rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {device.name}
                    </div>
                    {device.location && (
                      <div className="label" style={{ marginTop: 2 }}>{device.location}</div>
                    )}
                  </div>
                  <StatusPill
                    tone={device.status === 'online' ? 'success' : device.status === 'warning' ? 'warning' : 'danger'}
                  >
                    {device.status}
                  </StatusPill>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ─ Weather Location ───────────────────────────────────────────────── */}
      <section className="panel page-section settings-section">
        <div>
          <p className="eyebrow">Weather</p>
          <h2>Location Settings</h2>
        </div>

        {savedLocation && (
          <div className="key-value-item">
            <span className="label">Current Location</span>
            <strong className="settings-location-saved">
              <MapPin size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
              {savedLocation}
            </strong>
          </div>
        )}

        <p className="section-copy">
          Enter your city and state or zip code to enable live weather. Uses Open-Meteo — no account required.
        </p>

        <div className="settings-location-form">
          <input
            className="settings-location-input"
            type="text"
            placeholder="e.g. Greenville, TX  or  75401"
            value={locationQuery}
            onChange={(e) => setLocationQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleGeoSearch() }}
          />
          <button
            type="button"
            className="action-button"
            onClick={() => void handleGeoSearch()}
            disabled={geoSearching || !locationQuery.trim()}
          >
            <Search size={15} />
            {geoSearching ? 'Searching...' : 'Find Location'}
          </button>
        </div>

        {geoError && <div className="alert alert--danger">{geoError}</div>}

        {geoResults.length > 0 && (
          <div className="settings-geo-results">
            <p className="label">Select your location:</p>
            {geoResults.map((r) => (
              <button
                key={`${r.latitude},${r.longitude}`}
                type="button"
                className="settings-geo-result-btn"
                onClick={() => void handleSelectLocation(r)}
                disabled={locationSaving}
              >
                <MapPin size={13} />
                <span>{r.label}</span>
                <span className="settings-geo-coords">{r.latitude.toFixed(2)}, {r.longitude.toFixed(2)}</span>
              </button>
            ))}
          </div>
        )}

        {locationSaveMsg && (
          <div className={`alert ${locationSaveMsg.startsWith('Save failed') ? 'alert--danger' : 'alert--success'}`}>
            {locationSaveMsg}
          </div>
        )}
      </section>

      {/* ─ Developer Diagnostics ──────────────────────────────────────────── */}
      <details className="panel page-section dev-diagnostics">
        <summary>
          <ChevronDown size={13} style={{ marginRight: 6, verticalAlign: 'middle' }} />
          Developer Diagnostics
        </summary>
        <div className="settings-connection-grid" style={{ marginTop: 16 }}>
          <div className="settings-stat-row">
            <span className="label">Environment</span>
            <span className="mono">
              {localMode ? 'local-mock' : isSupabaseConfigured ? 'cloud' : 'not-configured'}
            </span>
          </div>
          <div className="settings-stat-row">
            <span className="label">Project URL</span>
            <span className="mono">
              {isSupabaseConfigured ? maskProjectUrl(supabaseUrl) : 'Not configured'}
            </span>
          </div>
          <div className="settings-stat-row">
            <span className="label">API Endpoint</span>
            <span className="mono">
              {isSupabaseConfigured ? `${maskProjectUrl(supabaseUrl)}/rest/v1` : '—'}
            </span>
          </div>
          <div className="settings-stat-row settings-stat-row--last">
            <span className="label">Connection Detail</span>
            <span className="mono" style={{ textAlign: 'right', maxWidth: 280, wordBreak: 'break-word' }}>
              {connectionMessage}
            </span>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <StatusPill tone={connTone}>
            {connectionState === 'connected'
              ? <><CheckCircle2 size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />Connected</>
              : connectionState === 'checking'
                ? <><Loader2 size={12} className="spin" style={{ marginRight: 4, verticalAlign: 'middle' }} />Checking</>
                : <><XCircle size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />{connectionState}</>
            }
          </StatusPill>
        </div>
      </details>

    </section>
  )
}
