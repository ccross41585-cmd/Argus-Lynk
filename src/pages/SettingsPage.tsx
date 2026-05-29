import { useEffect, useState } from 'react'
import { StatusPill } from '../components/StatusPill'
import { maskProjectUrl } from '../lib/display'
import { isSupabaseConfigured, supabase, supabaseUrl } from '../lib/supabase'

type SettingsPageProps = {
  localMode: boolean
  onSignOut: () => Promise<void>
}

export function SettingsPage({ localMode, onSignOut }: SettingsPageProps) {
  const [connectionState, setConnectionState] = useState<'checking' | 'connected' | 'error' | 'missing'>(
    isSupabaseConfigured ? 'checking' : 'missing',
  )
  const [connectionMessage, setConnectionMessage] = useState('Waiting for Supabase check...')

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