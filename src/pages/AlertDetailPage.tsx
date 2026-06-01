import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ChevronLeft, Clock, Loader2, VolumeX, X } from 'lucide-react'
import { StatusPill } from '../components/StatusPill'
import { getAlertById, getDeviceById, getDashboardStatus } from '../lib/dashboardMock'
import {
  createWellPumpShutoffCommand,
  createWellPumpExtendCommand,
  acknowledgeAlertCommand,
  silenceAlertCommand,
} from '../services/commands'
import type { AlertRecord, DashboardDevice, DashboardOverview } from '../types/dashboard'

// ── Well pump action phase ────────────────────────────────────────────────────

type WellPumpPhase =
  | 'question'       // initial: "Are you using water?"
  | 'extended'       // user confirmed water use — alert silenced
  | 'awaiting'       // shutoff command sent — waiting for field confirmation
  | 'confirmed'      // field node confirmed pump is off
  | 'failed'         // shutoff command failed

function formatTime(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso))
}

function minutesAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (diff < 1) return 'just now'
  if (diff === 1) return '1 min ago'
  if (diff < 60) return `${diff} min ago`
  return `${Math.floor(diff / 60)}h ago`
}

// ── Well pump long-run detail card ────────────────────────────────────────────

interface WellPumpActionProps {
  alert: AlertRecord
  device: DashboardDevice
  overview: DashboardOverview | null
  localMode: boolean
  userId: string | null
  onAlertUpdate: (updated: Partial<AlertRecord>) => void
}

function WellPumpActionCard({ alert, device, overview, localMode, userId, onAlertUpdate }: WellPumpActionProps) {
  const [phase, setPhase] = useState<WellPumpPhase>('question')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmTimerRef = useRef<number | null>(null)

  // Simulate field-node confirmation in local mode
  useEffect(() => {
    if (phase === 'awaiting' && localMode) {
      confirmTimerRef.current = window.setTimeout(() => {
        setPhase('confirmed')
        onAlertUpdate({ resolved_at: new Date().toISOString() })
      }, 3000)
    }
    return () => { if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current) }
  }, [phase, localMode, onAlertUpdate])

  async function handleYesUsingWater() {
    setBusy(true)
    setError(null)
    const { error: cmdError } = await createWellPumpExtendCommand(device.id, alert.id, localMode, userId ?? undefined)
    if (cmdError) { setError(cmdError); setBusy(false); return }
    await acknowledgeAlertCommand(alert.id, localMode)
    onAlertUpdate({ acknowledged: true })
    setPhase('extended')
    setBusy(false)
  }

  async function handleNoShutoff() {
    setBusy(true)
    setError(null)
    const { error: cmdError } = await createWellPumpShutoffCommand(device.id, alert.id, localMode, userId ?? undefined)
    if (cmdError) { setError(cmdError); setBusy(false); return }
    setPhase('awaiting')
    setBusy(false)
  }

  async function handleSilence() {
    setBusy(true)
    setError(null)
    const { error: cmdError } = await silenceAlertCommand(alert.id, localMode)
    if (cmdError) { setError(cmdError); setBusy(false); return }
    onAlertUpdate({ silenced_until: new Date(Date.now() + 30 * 60_000).toISOString() })
    setBusy(false)
  }

  const pump = overview?.wellPump

  return (
    <div className="alert-detail-action-card panel stack">
      {/* Device status summary */}
      <div className="alert-detail-device-row">
        <div>
          <p className="eyebrow">Well Pump</p>
          <p style={{ fontWeight: 600, margin: 0 }}>{device.name}</p>
          {device.location && <p className="label">{device.location}</p>}
        </div>
        <div style={{ textAlign: 'right' }}>
          {pump && (
            <>
              <p className="mono" style={{ fontSize: '1.1rem', color: 'var(--accent-strong)', margin: 0 }}>
                {pump.runtime}
              </p>
              <p className="label" style={{ margin: 0 }}>runtime</p>
            </>
          )}
        </div>
      </div>

      {pump && (
        <div className="key-value-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 20px' }}>
          <div>
            <span className="label">Pump Power</span>
            <StatusPill tone={pump.pumpPower === 'ON' ? 'success' : 'neutral'}>{pump.pumpPower}</StatusPill>
          </div>
          <div>
            <span className="label">Field Node</span>
            <StatusPill tone={pump.fieldNode === 'Online' ? 'success' : 'danger'}>{pump.fieldNode}</StatusPill>
          </div>
          <div>
            <span className="label">Contactor</span>
            <p className="label" style={{ marginTop: 2 }}>{pump.feedback}</p>
          </div>
          <div>
            <span className="label">Threshold</span>
            <p className="label" style={{ marginTop: 2 }}>{pump.thresholdMinutes} min</p>
          </div>
        </div>
      )}

      {/* Phase-based action UI */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 16 }}>
        {phase === 'question' && (
          <>
            <p style={{ fontWeight: 600, marginBottom: 12 }}>
              Well pump has been running longer than normal. Are you using water?
            </p>
            <div className="alert-detail-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleYesUsingWater()}
                disabled={busy}
              >
                {busy ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />}
                Yes, I'm using water
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void handleNoShutoff()}
                disabled={busy}
              >
                {busy ? <Loader2 size={15} className="spin" /> : <X size={15} />}
                No, shut pump off
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void handleSilence()}
                disabled={busy}
              >
                <VolumeX size={15} />
                Silence alert
              </button>
            </div>
          </>
        )}

        {phase === 'extended' && (
          <div className="alert alert--success" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CheckCircle2 size={16} />
            Alert acknowledged. Runtime extended. Check back if the pump keeps running.
          </div>
        )}

        {phase === 'awaiting' && (
          <div className="alert alert--warning" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Loader2 size={16} className="spin" />
            Shutdown command sent. Waiting for field node confirmation…
          </div>
        )}

        {phase === 'confirmed' && (
          <div className="alert alert--success" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <CheckCircle2 size={16} />
            Field node confirmed — pump is OFF. Alert resolved.
          </div>
        )}

        {phase === 'failed' && (
          <div className="alert alert--danger" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <AlertTriangle size={16} />
            Shutoff command failed. Check gateway and field node.
          </div>
        )}
      </div>

      {error && <div className="alert alert--danger">{error}</div>}
    </div>
  )
}

// ── Generic alert action card ─────────────────────────────────────────────────

interface GenericActionProps {
  alert: AlertRecord
  device: DashboardDevice | null
  localMode: boolean
  onAlertUpdate: (updated: Partial<AlertRecord>) => void
}

function GenericActionCard({ alert, device, localMode, onAlertUpdate }: GenericActionProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isSilenced = alert.silenced_until && new Date(alert.silenced_until) > new Date()

  async function handleAck() {
    setBusy(true)
    const { error: e } = await acknowledgeAlertCommand(alert.id, localMode)
    if (e) setError(e)
    else onAlertUpdate({ acknowledged: true })
    setBusy(false)
  }

  async function handleSilence() {
    setBusy(true)
    const { error: e } = await silenceAlertCommand(alert.id, localMode)
    if (e) setError(e)
    else onAlertUpdate({ silenced_until: new Date(Date.now() + 30 * 60_000).toISOString() })
    setBusy(false)
  }

  return (
    <div className="panel stack">
      {device && (
        <div className="alert-detail-device-row">
          <div>
            <p className="eyebrow">{device.type.replace(/_/g, ' ')}</p>
            <p style={{ fontWeight: 600, margin: 0 }}>{device.name}</p>
            {device.location && <p className="label">{device.location}</p>}
          </div>
          <StatusPill
            tone={device.status === 'online' ? 'success' : device.status === 'warning' ? 'warning' : 'danger'}
          >
            {device.status}
          </StatusPill>
        </div>
      )}

      <p style={{ margin: 0 }}>{alert.message}</p>

      {isSilenced && (
        <p className="label">Silenced until {formatTime(alert.silenced_until!)}</p>
      )}

      <div className="alert-detail-actions">
        {!alert.acknowledged && !alert.resolved_at && (
          <button type="button" className="primary-button" onClick={() => void handleAck()} disabled={busy}>
            {busy ? <Loader2 size={15} className="spin" /> : <CheckCircle2 size={15} />}
            Acknowledge
          </button>
        )}
        {!isSilenced && !alert.resolved_at && (
          <button type="button" className="ghost-button" onClick={() => void handleSilence()} disabled={busy}>
            <VolumeX size={15} />
            Silence 30m
          </button>
        )}
        {alert.resolved_at && (
          <p className="label">Resolved {formatTime(alert.resolved_at)}</p>
        )}
      </div>

      {error && <div className="alert alert--danger">{error}</div>}
    </div>
  )
}

// ── Alert detail page ─────────────────────────────────────────────────────────

interface AlertDetailPageProps {
  localMode: boolean
  userId: string | null
}

export function AlertDetailPage({ localMode, userId }: AlertDetailPageProps) {
  const { alertId } = useParams<{ alertId: string }>()
  const [alert, setAlert] = useState<AlertRecord | null>(null)
  const [device, setDevice] = useState<DashboardDevice | null>(null)
  const [overview, setOverview] = useState<DashboardOverview | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!alertId) { setNotFound(true); setIsLoading(false); return }
    document.title = 'Argus Lynk | Alert Detail'

    void Promise.all([getAlertById(alertId), getDashboardStatus()]).then(async ([a, ov]) => {
      if (!a) { setNotFound(true); setIsLoading(false); return }
      setAlert(a)
      setOverview(ov)
      const dev = await getDeviceById(a.device_id)
      setDevice(dev)
      setIsLoading(false)
    })
  }, [alertId])

  function handleAlertUpdate(patch: Partial<AlertRecord>) {
    setAlert((prev) => prev ? { ...prev, ...patch } : prev)
  }

  const severityTone =
    alert?.severity === 'critical' ? 'danger'
    : alert?.severity === 'warning' ? 'warning'
    : 'info'

  if (isLoading) {
    return (
      <div className="alert-detail-page">
        <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '24px' }}>
          <Loader2 size={20} className="spin" />
          <span>Loading alert…</span>
        </div>
      </div>
    )
  }

  if (notFound || !alert) {
    return (
      <div className="alert-detail-page">
        <Link to="/alerts" className="back-link">
          <ChevronLeft size={14} style={{ verticalAlign: 'middle' }} />
          Back to Alerts
        </Link>
        <div className="panel" style={{ textAlign: 'center', padding: '32px' }}>
          <p className="eyebrow">Not Found</p>
          <p className="muted-copy">Alert not found or already removed.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="alert-detail-page stack">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Link to="/alerts" className="back-link">
          <ChevronLeft size={14} style={{ verticalAlign: 'middle' }} />
          Alerts
        </Link>
      </div>

      {/* Alert header */}
      <div className="panel stack">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <p className="eyebrow">{alert.type.replace(/_/g, ' ')}</p>
            <h1 style={{ margin: '4px 0 0', fontSize: '1.35rem' }}>{alert.message}</h1>
          </div>
          <StatusPill tone={severityTone}>{alert.severity}</StatusPill>
        </div>

        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <span className="label">Created</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
              <Clock size={13} style={{ color: 'var(--muted)' }} />
              <span className="mono" style={{ fontSize: '0.85rem' }}>
                {formatTime(alert.created_at)} · {minutesAgo(alert.created_at)}
              </span>
            </div>
          </div>
          <div>
            <span className="label">Status</span>
            <div style={{ marginTop: 4 }}>
              {alert.resolved_at
                ? <StatusPill tone="success">Resolved</StatusPill>
                : alert.acknowledged
                  ? <StatusPill tone="info">Acknowledged</StatusPill>
                  : <StatusPill tone={severityTone}>Active</StatusPill>
              }
            </div>
          </div>
        </div>
      </div>

      {/* Type-specific action card */}
      {alert.type === 'well_pump_long_runtime' && device ? (
        <WellPumpActionCard
          alert={alert}
          device={device}
          overview={overview}
          localMode={localMode}
          userId={userId}
          onAlertUpdate={handleAlertUpdate}
        />
      ) : (
        <GenericActionCard
          alert={alert}
          device={device}
          localMode={localMode}
          onAlertUpdate={handleAlertUpdate}
        />
      )}
    </div>
  )
}
