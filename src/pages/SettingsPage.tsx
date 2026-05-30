import { useEffect, useState } from 'react'
import { MapPin, Search } from 'lucide-react'
import { StatusPill } from '../components/StatusPill'
import { maskProjectUrl } from '../lib/display'
import { isSupabaseConfigured, supabase, supabaseUrl } from '../lib/supabase'
import { geocodeLocation, type GeoResult } from '../lib/weather'
import { loadUserProfile, saveUserLocation } from '../lib/userProfile'

type SettingsPageProps = {
  localMode: boolean
  userId: string | null
  onSignOut: () => Promise<void>
}

export function SettingsPage({ localMode, userId, onSignOut }: SettingsPageProps) {
  const [connectionState, setConnectionState] = useState<'checking' | 'connected' | 'error' | 'missing'>(
    isSupabaseConfigured ? 'checking' : 'missing',
  )
  const [connectionMessage, setConnectionMessage] = useState('Waiting for Supabase check...')

  // ── Location state ──────────────────────────────────────────────────────
  const [locationQuery, setLocationQuery] = useState('')
  const [geoResults, setGeoResults] = useState<GeoResult[]>([])
  const [geoSearching, setGeoSearching] = useState(false)
  const [geoError, setGeoError] = useState<string | null>(null)
  const [savedLocation, setSavedLocation] = useState<string | null>(null)
  const [locationSaving, setLocationSaving] = useState(false)
  const [locationSaveMsg, setLocationSaveMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) {
      setConnectionState('missing')
      setConnectionMessage('Missing Supabase environment variables.')
      return
    }

    const client = supabase

    let isActive = true

    async function checkConnection() {
      const { error } = await client.from('devices').select('id', { head: true, count: 'exact' })

      if (!isActive) {
        return
      }

      if (error) {
        setConnectionState('error')
        setConnectionMessage(error.message)
        return
      }

      setConnectionState('connected')
      setConnectionMessage('Supabase responded successfully.')
    }

    void checkConnection()

    return () => {
      isActive = false
    }
  }, [])

  // Load existing saved location
  useEffect(() => {
    if (!userId) return
    loadUserProfile(userId).then((profile) => {
      if (profile?.location_label) setSavedLocation(profile.location_label)
    }).catch(() => {/* silent */})
  }, [userId])

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

  return (
    <section className="stack">
      <header className="panel hero-card page-header">
        <p className="eyebrow">Settings</p>
        <h1>Control Surface Setup</h1>
        <p className="section-copy">
          Connection health, local testing mode, and placeholders for future gateway setup live here.
        </p>
      </header>

      <section className="settings-grid">
        <article className="panel settings-card stack">
          <div className="settings-card__header">
            <p className="eyebrow">Supabase</p>
            <h2>Connection Status</h2>
          </div>
          <StatusPill
            tone={
              connectionState === 'connected'
                ? 'success'
                : connectionState === 'checking'
                  ? 'warning'
                  : 'danger'
            }
          >
            {connectionState}
          </StatusPill>
          <p className="section-copy">{connectionMessage}</p>
          <div className="key-value-item">
            <span className="label">Project URL</span>
            <strong className="mono">{isSupabaseConfigured ? maskProjectUrl(supabaseUrl) : 'Not configured'}</strong>
          </div>
        </article>

        <article className="panel settings-card stack">
          <div className="settings-card__header">
            <p className="eyebrow">Gateway</p>
            <h2>Base Station Placeholder</h2>
          </div>
          <p className="section-copy">
            Later this screen can show gateway heartbeat, gateway id binding, and command queue health.
          </p>
          <div className="alert alert--neutral">Gateway pairing UI is not implemented yet.</div>
        </article>

        <article className="panel settings-card stack">
          <div className="settings-card__header">
            <p className="eyebrow">Bluetooth</p>
            <h2>Fallback Placeholder</h2>
          </div>
          <p className="section-copy">
            Reserve this section for direct phone-to-device control if LoRa or gateway connectivity fails.
          </p>
          <div className="alert alert--neutral">Bluetooth fallback is planned, not included in this MVP.</div>
        </article>
      </section>

      <section className="panel page-section stack">
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
          Enter your city and state or zip code to enable live weather on the dashboard. Uses Open-Meteo — no account required.
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
            {geoSearching ? 'Searching…' : 'Find Location'}
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

      <section className="panel page-section stack">
        <div>
          <p className="eyebrow">Session</p>
          <h2>Operator Mode</h2>
        </div>
        <StatusPill tone={localMode ? 'warning' : 'success'}>
          {localMode ? 'Local Test Mode Active' : 'Signed In'}
        </StatusPill>
        <button type="button" className="ghost-button" onClick={() => void onSignOut()}>
          End Session
        </button>
      </section>
    </section>
  )
}