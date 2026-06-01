import { useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  Cpu,
  Loader2,
  MapPin,
  Plus,
  Radio,
  Search,
  Wifi,
  WifiOff,
  XCircle,
} from 'lucide-react'
import { StatusPill } from '../components/StatusPill'
import { maskProjectUrl } from '../lib/display'
import { isSupabaseConfigured, supabase, supabaseUrl } from '../lib/supabase'
import { geocodeLocation, type GeoResult } from '../lib/weather'
import { loadUserProfile, saveUserLocation } from '../lib/userProfile'
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
  signalStrength: string
  displayName: string
  location: string
  pinToHome: boolean
}

const WIZARD_INIT: WizardState = {
  step: 'closed',
  deviceType: null,
  pairingMethod: null,
  detectedNodeId: '',
  signalStrength: '',
  displayName: '',
  location: '',
  pinToHome: false,
}

const DEVICE_TYPE_OPTIONS: { value: DeviceTypeChoice; label: string; abbr: string }[] = [
  { value: 'fence',     label: 'Fence Controller',      abbr: 'FEN' },
  { value: 'well_pump', label: 'Well Pump Controller',  abbr: 'PMP' },
  { value: 'freezer',   label: 'Freezer Sensor',        abbr: 'FRZ' },
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

// ─── Component ────────────────────────────────────────────────────────────────

export function SettingsPage({ localMode, userId, onSignOut }: SettingsPageProps) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('checking')
  const [connectionMessage, setConnectionMessage] = useState('Checking cloud connection...')
  const [lastSync, setLastSync] = useState<string | null>(null)
  const [queueDepth, setQueueDepth] = useState<number | null>(null)

  const [locationQuery, setLocationQuery] = useState('')
  const [geoResults, setGeoResults] = useState<GeoResult[]>([])
  const [geoSearching, setGeoSearching] = useState(false)
  const [geoError, setGeoError] = useState<string | null>(null)
  const [savedLocation, setSavedLocation] = useState<string | null>(null)
  const [locationSaving, setLocationSaving] = useState(false)
  const [locationSaveMsg, setLocationSaveMsg] = useState<string | null>(null)

  const [devices, setDevices] = useState<DashboardDevice[]>([])
  const [wizard, setWizard] = useState<WizardState>(WIZARD_INIT)
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

  // ── Load mock data ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!localMode) return
    getDashboardStatus().then((status) => setQueueDepth(status.system.queueDepth))
    getDevices().then(setDevices)
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
          signalStrength: DETECTED_NODE.signal,
        }))
      }, 2000)
    } else {
      setWizard((w) => ({
        ...w,
        step: 'configure',
        pairingMethod: method,
        detectedNodeId: method === 'qr' ? DETECTED_NODE.nodeId : '',
        signalStrength: method === 'qr' ? DETECTED_NODE.signal : '',
      }))
    }
  }

  function wizardSave() {
    const name = wizard.displayName.trim() || `${wizard.deviceType ?? 'Device'}-new`
    setAddedDevice(name)
    setWizard({ ...WIZARD_INIT, step: 'done' })
  }

  function wizardClose() {
    if (detectTimerRef.current) clearTimeout(detectTimerRef.current)
    setWizard(WIZARD_INIT)
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

                <button
                  type="button"
                  className="action-button"
                  onClick={wizardSave}
                  disabled={!wizard.displayName.trim()}
                >
                  Save Device
                </button>
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
